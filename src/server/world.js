// Authoritative server world: owns ALL terrain generation. Storage
// primitives (Chunk, coordinate helpers) are shared with the client;
// everything noise/tree/terrain related lives only here.
import { PerlinNoise } from './perlin.js';
import { blockRegistry } from './BlockRegistryServer.js';
import { World as BaseWorld, Chunk, CHUNK_SIZE, SEA_LEVEL } from '../client/world.js';

export class ServerWorld extends BaseWorld {
    constructor(seed = 42) {
        super();
        this.seed = seed;
        this.perlin = new PerlinNoise(seed);
        // Terrain params
        this.baseHeight = 5;
        this.heightScale = 12;
        this.noiseFreq  = 0.015;

        // Resolve modded block ids once; the registry must be loaded
        // (loadMods()) before a ServerWorld is constructed.
        const id = (name) => {
            const idVal = blockRegistry.id(name);
            if (idVal === -1) throw new Error(`[server-world] required block '${name}' not registered by any mod`);
            return idVal;
        };
        this.ids = {
            stone:  id('sable:stone'),
            dirt:   id('sable:dirt'),
            grass:  id('sable:grass'),
            sand:   id('sable:sand'),
            log:    id('sable:log'),
            leaves: id('sable:leaf'),
            water:  id('sable:water')
        };
    }

    // Terrain at or below this height gets a sand floor/beach instead of
    // grass: underwater ground plus a small lip above the waterline.
    isBeachLevel(surfaceY) {
        return surfaceY <= SEA_LEVEL + 1;
    }

    //  Terrain height 
    getHeight(wx, wz) {
        const h = this.perlin.fbm(wx * this.noiseFreq, wz * this.noiseFreq,
                                   4, 0.45, 2.2);
        return Math.max(-1, Math.floor(h * this.heightScale + this.baseHeight));
    }

    // Get the surface height at a world grid position (topmost solid block y).
    getSurfaceY(gx, gz) {
        // Use the height function directly for generated chunks,
        // or scan from top down for chunks that may have been modified.
        const cx = BaseWorld.toChunkCoord(gx);
        const cz = BaseWorld.toChunkCoord(gz);
        const chunk = this.chunks.get(BaseWorld.chunkKey(cx, cz));
        if (!chunk || !chunk.generated) return this.getHeight(gx, gz);
        for (let y = 20; y >= -1; y--) {
            const t = chunk.voxels.get(`${BaseWorld.toLocal(gx)},${y},${BaseWorld.toLocal(gz)}`);
            if (t !== undefined && blockRegistry.isSolid(t)) return y;
        }
        return -1;
    }

    //  Chunk management 
    ensureChunk(cx, cz) {
        const key = BaseWorld.chunkKey(cx, cz);
        let chunk = this.chunks.get(key);
        if (chunk) return chunk;
        chunk = new Chunk(cx, cz);
        // Register before generating so cross-chunk tree placement can
        // reference this chunk without recursing into generation again.
        this.chunks.set(key, chunk);
        this.generateChunk(cx, cz, chunk);
        return chunk;
    }

    generateChunk(cx, cz, chunk = new Chunk(cx, cz)) {
        const ox = cx * CHUNK_SIZE;
        const oz = cz * CHUNK_SIZE;

        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
            for (let lz = 0; lz < CHUNK_SIZE; lz++) {
                const wx = ox + lx;
                const wz = oz + lz;
                const surfaceY = this.getHeight(wx, wz);
                const sandy = this.isBeachLevel(surfaceY);
                for (let y = -1; y <= surfaceY; y++) {
                    let blockType = this.ids.stone;
                    if (y === surfaceY) {
                        blockType = sandy ? this.ids.sand : this.ids.grass;
                    } else if (y === surfaceY - 1 || y === surfaceY - 2) {
                        blockType = sandy ? this.ids.sand : this.ids.dirt;
                    }
                    chunk.set(lx, y, lz, blockType);
                }
                // Fill valleys with water up to sea level
                for (let y = surfaceY + 1; y <= SEA_LEVEL; y++) {
                    chunk.set(lx, y, lz, this.ids.water);
                }
            }
        }

        this.generateTrees(chunk, ox, oz);
        this.generateDecorations(chunk, ox, oz);

        chunk.generated = true;
        return chunk;
    }

    // Scatter modded decorations (plants, flowers, ...) over the chunk.
    // Each decoration divides the world into spread×spread cells; every cell
    // has exactly one candidate position derived purely from the seed and
    // the cell coordinates, so placement never depends on chunk generation
    // order and cells straddling a chunk border spawn in exactly one chunk.
    generateDecorations(chunk, ox, oz) {
        const decos = blockRegistry.decorations;
        if (!decos || decos.length === 0) return;

        for (const d of decos) {
            const S = d.spread;
            const gx0 = Math.floor(ox / S), gx1 = Math.floor((ox + CHUNK_SIZE - 1) / S);
            const gz0 = Math.floor(oz / S), gz1 = Math.floor((oz + CHUNK_SIZE - 1) / S);

            for (let gcx = gx0; gcx <= gx1; gcx++) {
                for (let gcz = gz0; gcz <= gz1; gcz++) {
                    if (hash01(gcx, gcz, d.ordinal * 2654435761 + 7) >= d.density) continue;

                    const wx = gcx * S + Math.floor(hash01(gcx, gcz, d.ordinal + 101) * S);
                    const wz = gcz * S + Math.floor(hash01(gcx, gcz, d.ordinal + 211) * S);

                    // Candidate may fall outside this chunk; whichever chunk
                    // contains it will place it.
                    const lx = wx - ox;
                    const lz = wz - oz;
                    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) continue;

                    const surfaceY = this.getHeight(wx, wz);
                    if (surfaceY < d.minHeight || surfaceY > d.maxHeight) continue;

                    const y = surfaceY + 1;
                    if (y > MAX_Y) continue;

                    // Ground must be real generated solid terrain, and the
                    // target cell must be free (skips water columns, tree
                    // trunks and any other occupied spot).
                    const ground = chunk.voxels.get(`${lx},${surfaceY},${lz}`);
                    if (ground === undefined || !blockRegistry.isSolid(ground)) continue;
                    if (chunk.has(lx, y, lz)) continue;

                    chunk.set(lx, y, lz, d.blockId);
                }
            }
        }
    }

    generateTrees(chunk, ox, oz) {
        // Helper function to place blocks across chunk boundaries
        const setBlockCrossChunk = (lx, ly, lz, blockType) => {
            if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
                // Within current chunk
                if (!chunk.has(lx, ly, lz)) {
                    chunk.set(lx, ly, lz, blockType);
                }
            } else {
                // Outside current chunk - calculate world coordinates and place in neighbor
                const wx = ox + lx;
                const wz = oz + lz;
                const ncx = Math.floor(wx / CHUNK_SIZE);
                const ncz = Math.floor(wz / CHUNK_SIZE);

                // Ensure neighbor chunk exists
                const neighborChunk = this.ensureChunk(ncx, ncz);
                const nlx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
                const nlz = ((wz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

                if (!neighborChunk.has(nlx, ly, nlz)) {
                    neighborChunk.set(nlx, ly, nlz, blockType);
                    neighborChunk.dirty = true;
                }
            }
        };

        // Deterministic hash for tree placement (world-cell based)
        const hash01 = (x, z, s) => {
            let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(s, 1440662683);
            h = Math.imul(h ^ (h >>> 13), 1274126177);
            h ^= h >>> 16;
            return (h >>> 0) / 4294967296;
        };

        const placeTreeAt = (lx, lz) => {
            const wx = ox + lx;
            const wz = oz + lz;

            // Get surface height at this position
            const surfaceY = this.getHeight(wx, wz);

            // Check if we can place a tree here (dry grass block, not too steep)
            if (this.isBeachLevel(surfaceY)) return; // Underwater or on the beach

            // Tree parameters - 5 layers total for leaves
            const trunkHeight = 5; // Fixed height for this pattern

            // Replace the grass under the trunk with dirt
            chunk.set(lx, surfaceY, lz, this.ids.dirt);

            // Place trunk
            for (let y = 1; y <= trunkHeight; y++) {
                const py = surfaceY + y;
                setBlockCrossChunk.call(this, lx, py, lz, this.ids.log);
            }

            const leafBase = surfaceY + trunkHeight - 1; // Start 1 below top of trunk

            // Layers 1-2: 5x5 (bottom 2 layers)
            for (let layer = 0; layer < 2; layer++) {
                const ly = leafBase + layer;
                for (let dx = -2; dx <= 2; dx++) {
                    for (let dz = -2; dz <= 2; dz++) {
                        // Skip trunk position
                        if (dx === 0 && dz === 0) continue;

                        const nlx = lx + dx;
                        const nlz = lz + dz;

                        setBlockCrossChunk.call(this, nlx, ly, nlz, this.ids.leaves);
                    }
                }
            }

            // Layer 3: 3x3 (middle layer)
            const ly3 = leafBase + 2;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dz = -1; dz <= 1; dz++) {
                    // Skip trunk position
                    if (dx === 0 && dz === 0) continue;

                    const nlx = lx + dx;
                    const nlz = lz + dz;

                    setBlockCrossChunk.call(this, nlx, ly3, nlz, this.ids.leaves);
                }
            }

            // Layers 4-5: 3x3 cross (+) (top 2 layers)
            for (let layer = 3; layer < 5; layer++) {
                const ly = leafBase + layer;

                // Cross pattern: center row and center column
                for (let d = -1; d <= 1; d++) {
                    // Center row (dz varies, dx = 0)
                    const nlx1 = lx;
                    const nlz1 = lz + d;
                    setBlockCrossChunk.call(this, nlx1, ly, nlz1, this.ids.leaves);

                    // Center column (dx varies, dz = 0) - skip center (trunk)
                    if (d !== 0) {
                        const nlx2 = lx + d;
                        const nlz2 = lz;
                        setBlockCrossChunk.call(this, nlx2, ly, nlz2, this.ids.leaves);
                    }
                }
            }
        };

        // At most one tree per 8×8 world cell, jittered into the middle of
        // its cell so any two trunks are at least 2*MARGIN+1 blocks apart.
        // CELL divides CHUNK_SIZE, so cells never straddle chunk borders and
        // placement is identical regardless of chunk generation order.
        const CELL   = 8;
        const MARGIN = 2;
        const TREE_CHANCE = 0.75;

        for (let cxo = 0; cxo < CHUNK_SIZE; cxo += CELL) {
            for (let czo = 0; czo < CHUNK_SIZE; czo += CELL) {
                const gcx = ox / CELL + cxo / CELL;
                const gcz = oz / CELL + czo / CELL;
                if (hash01(gcx, gcz, 1) > TREE_CHANCE) continue;
                placeTreeAt(
                    cxo + MARGIN + Math.floor(hash01(gcx, gcz, 2) * (CELL - 2 * MARGIN)),
                    czo + MARGIN + Math.floor(hash01(gcx, gcz, 3) * (CELL - 2 * MARGIN))
                );
            }
        }
    }

    // Generate (if needed) and return sparse voxel quads [lx,ly,lz,type,...]
    getChunkPacked(cx, cz) {
        const chunk = this.ensureChunk(cx, cz);
        const out = [];
        for (const [k, t] of chunk.voxels) {
            const p1 = k.indexOf(',');
            const p2 = k.indexOf(',', p1 + 1);
            out.push(+k.substring(0, p1), +k.substring(p1 + 1, p2),
                     +k.substring(p2 + 1), t);
        }
        return out;
    }

    // Authoritative edit validation. Returns true (and applies) only when
    // the change is legal; otherwise leaves the world untouched.
    //   t < 0  -> break:  target block must exist
    //   t >= 0 -> place:  known type, target must be air or water,
    //                     coordinates in range, chunk generated
    validateEdit(x, y, z, t) {
        const fail = (why) => {
            console.log(`[integrated-server] edit ${x},${y},${z} type=${t} rejected: ${why}`);
            return false;
        };
        if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
            return fail('non-integer coordinates');
        }
        if (y < MIN_Y || y > MAX_Y) return fail('y out of range');

        const key = BaseWorld.chunkKey(BaseWorld.toChunkCoord(x), BaseWorld.toChunkCoord(z));
        const chunk = this.chunks.get(key);
        if (!chunk || !chunk.generated) return fail('chunk not generated');

        const lx = BaseWorld.toLocal(x);
        const lz = BaseWorld.toLocal(z);
        const existing = chunk.voxels.get(`${lx},${y},${lz}`);

        if (t < 0) {
            if (existing === undefined) return fail('nothing to break');
            this.delete(x, y, z);
            return true;
        }
        if (t > blockRegistry.maxBlockId || t < -1) return fail('unknown block type');
        // Air and fluids are replaceable placement targets
        if (existing !== undefined && !blockRegistry.isFluid(existing)) {
            return fail('target occupied');
        }
        this.set(x, y, z, t);
        return true;
    }
}

// Vertical build limits (generation spans -1..~21, leave headroom)
const MIN_Y = -1;
const MAX_Y = 31;

// Deterministic 2D hash -> [0,1). Shared by tree + decoration scattering.
function hash01(x, z, s) {
    let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(s, 1440662683);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

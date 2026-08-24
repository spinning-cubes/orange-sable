import { blocks } from './BlockRegistryClient.js';

export const CHUNK_SIZE = 16;
export const SEA_LEVEL = 3;

export class Chunk {
    constructor(cx, cz) {
        this.cx = cx;
        this.cz = cz;
        // Local voxel storage: "lx,ly,lz" -> blockType
        this.voxels = new Map();
        this.dirty = true;
        this.generated = false;
    }

    static voxelKey(lx, ly, lz) { return `${lx},${ly},${lz}`; }

    has(lx, ly, lz) { return this.voxels.has(Chunk.voxelKey(lx, ly, lz)); }
    get(lx, ly, lz) { return this.voxels.get(Chunk.voxelKey(lx, ly, lz)) ?? blocks.defaultId; }
    set(lx, ly, lz, blockType) { this.voxels.set(Chunk.voxelKey(lx, ly, lz), blockType); }
    remove(lx, ly, lz) { this.voxels.delete(Chunk.voxelKey(lx, ly, lz)); }

    *[Symbol.iterator]() {
        for (const k of this.voxels.keys()) {
            const p = k.indexOf(',');
            const p2 = k.indexOf(',', p + 1);
            yield [parseInt(k.substring(0, p)),
                   parseInt(k.substring(p + 1, p2)),
                   parseInt(k.substring(p2 + 1))];
        }
    }
}

export class World {
    // Client-side chunk mirror: voxel data arrives fully generated from
    // the integrated server; no terrain generation happens here.
    constructor(seed = 42) {
        this.chunks = new Map();   // "cx,cz" -> Chunk
    }

    //  Coordinate helpers 
    static chunkKey(cx, cz) { return `${cx},${cz}`; }

    static toChunkCoord(gx) { return Math.floor(gx / CHUNK_SIZE); }

    static toLocal(gx) { return ((gx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE; }

    // Surface height from stored voxels only (topmost non-fluid block y).
    getSurfaceY(gx, gz) {
        const cx = World.toChunkCoord(gx);
        const cz = World.toChunkCoord(gz);
        const chunk = this.chunks.get(World.chunkKey(cx, cz));
        if (!chunk || !chunk.generated) return 10;
        for (let y = 20; y >= -1; y--) {
            const t = chunk.voxels.get(`${World.toLocal(gx)},${y},${World.toLocal(gz)}`);
            if (t !== undefined && !blocks.isFluid(t)) return y;
        }
        return -1;
    }

    //  Chunk management 
    ensureChunk(cx, cz) {
        const key = World.chunkKey(cx, cz);
        let chunk = this.chunks.get(key);
        if (chunk) return chunk;
        chunk = new Chunk(cx, cz);
        this.chunks.set(key, chunk);
        return chunk;
    }

    unloadChunk(cx, cz) {
        this.chunks.delete(World.chunkKey(cx, cz));
    }

    isChunkLoaded(cx, cz) {
        return this.chunks.has(World.chunkKey(cx, cz));
    }

    isChunkDirty(cx, cz) {
        const c = this.chunks.get(World.chunkKey(cx, cz));
        return c ? c.dirty : false;
    }

    markChunkClean(cx, cz) {
        const c = this.chunks.get(World.chunkKey(cx, cz));
        if (c) c.dirty = false;
    }

    getLoadedChunkKeys() {
        return this.chunks.keys();
    }

    getChunk(cx, cz) {
        return this.chunks.get(World.chunkKey(cx, cz));
    }

    //  Voxel access (world grid coordinates) 
    has(x, y, z) {
        const cx = World.toChunkCoord(x);
        const cz = World.toChunkCoord(z);
        const chunk = this.chunks.get(World.chunkKey(cx, cz));
        if (!chunk) return false;
        return chunk.has(World.toLocal(x), y, World.toLocal(z));
    }

    // Solid = any generated block except fluids (water is pass-through)
    isSolid(x, y, z) {
        const cx = World.toChunkCoord(x);
        const cz = World.toChunkCoord(z);
        const chunk = this.chunks.get(World.chunkKey(cx, cz));
        if (!chunk) return false;
        const t = chunk.voxels.get(`${World.toLocal(x)},${y},${World.toLocal(z)}`);
        return t !== undefined && !blocks.isFluid(t);
    }

    set(x, y, z, blockType) {
        const cx = World.toChunkCoord(x);
        const cz = World.toChunkCoord(z);
        const chunk = this.ensureChunk(cx, cz);
        chunk.set(World.toLocal(x), y, World.toLocal(z), blockType);
        chunk.dirty = true;
        this._markNeighborChunksDirty(x, y, z);
    }

    delete(x, y, z) {
        const cx = World.toChunkCoord(x);
        const cz = World.toChunkCoord(z);
        const chunk = this.chunks.get(World.chunkKey(cx, cz));
        if (!chunk) return;
        chunk.remove(World.toLocal(x), y, World.toLocal(z));
        chunk.dirty = true;
        this._markNeighborChunksDirty(x, y, z);
    }

    _markNeighborChunksDirty(x, y, z) {
        const lx = World.toLocal(x);
        const lz = World.toLocal(z);
        const cx = World.toChunkCoord(x);
        const cz = World.toChunkCoord(z);
        if (lx === 0)             this._flagDirty(cx - 1, cz);
        if (lx === CHUNK_SIZE - 1) this._flagDirty(cx + 1, cz);
        if (lz === 0)             this._flagDirty(cx, cz - 1);
        if (lz === CHUNK_SIZE - 1) this._flagDirty(cx, cz + 1);
    }

    _flagDirty(cx, cz) {
        const c = this.chunks.get(World.chunkKey(cx, cz));
        if (c) c.dirty = true;
    }

    //  Iterate all loaded chunks 
    *loadedChunks() {
        for (const [key, chunk] of this.chunks) {
            yield chunk;
        }
    }
}

// Convenience: create a world and pre-load chunks around origin.
export function createWorld(seed = 42) {
    const world = new World(seed);
    return world;
}

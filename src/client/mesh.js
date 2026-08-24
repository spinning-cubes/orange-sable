import { CHUNK_SIZE } from './world.js';
import { blocks } from './BlockRegistryClient.js';

// 6 cube faces. Each corner: [x, y, z, u, v]. `dir` = neighbour offset for culling.
export const FACES = [
    { dir: [ 0, 0, 1], corners: [[-1,-1, 1, 0,1], [ 1,-1, 1, 1,1], [ 1, 1, 1, 1,0], [-1, 1, 1, 0,0]], norm: [0,0, 1] },
    { dir: [ 0, 0,-1], corners: [[ 1,-1,-1, 0,1], [-1,-1,-1, 1,1], [-1, 1,-1, 1,0], [ 1, 1,-1, 0,0]], norm: [0,0,-1] },
    { dir: [ 0, 1, 0], corners: [[-1, 1, 1, 0,1], [ 1, 1, 1, 1,1], [ 1, 1,-1, 1,0], [-1, 1,-1, 0,0]], norm: [0, 1,0] },
    { dir: [ 0,-1, 0], corners: [[-1,-1,-1, 0,1], [ 1,-1,-1, 1,1], [ 1,-1, 1, 1,0], [-1,-1, 1, 0,0]], norm: [0,-1,0] },
    { dir: [ 1, 0, 0], corners: [[ 1,-1, 1, 0,1], [ 1,-1,-1, 1,1], [ 1, 1,-1, 1,0], [ 1, 1, 1, 0,0]], norm: [ 1,0,0] },
    { dir: [-1, 0, 0], corners: [[-1,-1,-1, 0,1], [-1,-1, 1, 1,1], [-1, 1, 1, 1,0], [-1, 1,-1, 0,0]], norm: [-1,0,0] }
];

// UVs are tile-local [0,1] per block face; the tile index rides in a
// separate vertex attribute (texture array layer). Nudge inward by 1/8
// texel to keep sampling off the tile edge.
const PAD_UV = 0.125 / 16;

// Tolerance when deciding whether a nodebox face lies on the voxel boundary
const BOX_EPS = 1e-6;

// Fluid surfaces sit slightly below the block top (Minecraft-style lip)
const WATER_DROP = 2 * (1 / 16);

// Crossed-quad plant geometry ('plant' renderType). Two diagonal quads
// span the voxel; corner layout matches FACES ([x, y, z, u, v]) with
// v=1 at the bottom. emitPlantCross emits each quad front and back
// (reversed winding, mirrored U) so it reads correctly from both sides
// while back-face culling stays enabled.
const PLANT_QUADS = [
    [[-1,-1,-1,0,1], [ 1,-1, 1,1,1], [ 1, 1, 1,1,0], [-1, 1,-1,0,0]],
    [[-1,-1, 1,0,1], [ 1,-1,-1,1,1], [ 1, 1,-1,1,0], [-1, 1, 1,0,0]]
];

function makeGroup() {
    return { vertices: [], indices: [], vc: 0 };
}

// Build mesh for a single chunk.  The `world` object is used for
// cross-chunk neighbor lookups (face culling + AO).
// Vertex layout: position(3) + texCoord(2) + normal(3) + ao(1) + layer(1) = 10 floats.
// Geometry is split into three draw groups: opaque cubes, cutout
// transparents (alpha-discard: plants, glass-style blocks), and blend
// transparents (water-style alpha blending). renderTypes: 'node' cubes,
// 'plant' crossed quads, 'nodebox' arbitrary per-part boxes.
export function buildChunkMesh(world, chunk) {
    const opaque = makeGroup();
    const cutout = makeGroup();
    const blend  = makeGroup();

    const OX = chunk.cx * CHUNK_SIZE;
    const OZ = chunk.cz * CHUNK_SIZE;

    for (const [lx, ly, lz] of chunk) {
        const gx = OX + lx;
        const gz = OZ + lz;
        const cx = gx * 2.0, cy = ly * 2.0, cz = gz * 2.0;
        const blockType = chunk.get(lx, ly, lz);

        if (blocks.isPlant(blockType)) {
            emitPlantCross(cutout, cx, cy, cz,
                blocks.faceLayer(blockType, 0),
                world, gx, ly, gz,
                blocks.ambientOcclusion(blockType));
            continue;
        }

        const target = blocks.transparentType(blockType) === 'blend' ? blend
            : blocks.isTransparent(blockType) ? cutout
            : opaque;

        const parts = blocks.nodeboxParts(blockType);
        if (parts) {
            for (let p = 0; p < parts.length; p++) {
                emitBoxPart(target, world, gx, ly, gz, cx, cy, cz,
                    blockType, parts[p].box, p);
            }
            continue;
        }

        const isWater = blocks.isFluid(blockType);

        for (let f = 0; f < FACES.length; f++) {
            const face = FACES[f];

            // Face culling: hidden behind missing chunks never happens
            // (-1 = air). A face is skipped when the neighbour is opaque or
            // is the same transparent type (no internal water faces).
            // actsTransparent neighbours never hide adjacent faces.
            const nType = safeGetType(world,
                gx + face.dir[0], ly + face.dir[1], gz + face.dir[2]);
            if (nType !== -1 && (nType === blockType || !blocks.actsTransparent(nType))) continue;

            pushFace(target, world, face, gx, ly, gz, cx, cy, cz,
                blocks.faceLayer(blockType, f), isWater,
                blocks.ambientOcclusion(blockType));
        }
    }

    return {
        vertices: opaque.vertices, indices: opaque.indices, indexCount: opaque.indices.length,
        cutoutVertices: cutout.vertices, cutoutIndices: cutout.indices, cutoutIndexCount: cutout.indices.length,
        blendVertices: blend.vertices, blendIndices: blend.indices, blendIndexCount: blend.indices.length
    };
}

// Emit one quad (4 verts + indices) with optional per-corner AO.
// `face.corners` entries are [x, y, z, u, v] offsets from the block
// centre; u/v are UV fractions clamped into the padded tile.
function pushFace(group, world, face, gx, gy, gz, cx, cy, cz, textureOffset,
    lowerTop, useAO = true) {
    const aoLevels = [];

    for (let c = 0; c < 4; c++) {
        const corner = face.corners[c];
        const dx = corner[0], dy = corner[1], dz = corner[2];

        let s1 = 0, s2 = 0, cornerBlock = 0;
        if (useAO) {
            if (face.dir[0] !== 0) {
                const fnx = face.dir[0];
                s1 = safeHas(world, gx + fnx, gy + dy, gz) ? 1 : 0;
                s2 = safeHas(world, gx + fnx, gy, gz + dz) ? 1 : 0;
                cornerBlock = safeHas(world, gx + fnx, gy + dy, gz + dz) ? 1 : 0;
            } else if (face.dir[1] !== 0) {
                const fny = face.dir[1];
                s1 = safeHas(world, gx + dx, gy + fny, gz) ? 1 : 0;
                s2 = safeHas(world, gx, gy + fny, gz + dz) ? 1 : 0;
                cornerBlock = safeHas(world, gx + dx, gy + fny, gz + dz) ? 1 : 0;
            } else {
                const fnz = face.dir[2];
                s1 = safeHas(world, gx + dx, gy, gz + fnz) ? 1 : 0;
                s2 = safeHas(world, gx, gy + dy, gz + fnz) ? 1 : 0;
                cornerBlock = safeHas(world, gx + dx, gy + dy, gz + fnz) ? 1 : 0;
            }
        }

        const aoLevel = (s1 && s2) ? 3 : (s1 + s2 + cornerBlock);
        const aoFactor = [1.0, 0.72, 0.48, 0.25][aoLevel];
        aoLevels.push(aoLevel);

        // Tile-local UV + texture array layer. Corners carry real UV
        // fractions; clamp keeps the sample inside the padded tile.
        const texU = Math.min(Math.max(corner[3], PAD_UV), 1 - PAD_UV);
        const texV = Math.min(Math.max(corner[4], PAD_UV), 1 - PAD_UV);

        // Lower every water vertex that sits at the block top
        const vy = (lowerTop && dy === 1) ? cy + 1 - WATER_DROP : cy + dy;

        group.vertices.push(
            cx + corner[0], vy, cz + corner[2],
            texU, texV,
            face.norm[0], face.norm[1], face.norm[2],
            aoFactor, textureOffset
        );
    }

    const base = group.vc;

    // Flip quad to keep AO seams smooth.
    if (aoLevels[0] + aoLevels[2] > aoLevels[1] + aoLevels[3]) {
        group.indices.push(
            base + 1, base + 2, base + 3,
            base + 1, base + 3, base + 0
        );
    } else {
        group.indices.push(
            base + 0, base + 1, base + 2,
            base + 0, base + 2, base + 3
        );
    }
    group.vc += 4;
}

// Emit all visible faces of one nodebox part. `box` is [x1,y1,z1,x2,y2,z2]
// in -0.5..0.5 block-local units; engine voxels span ±1 so scale by 2.
// Faces lying exactly on the voxel boundary are culled like cube faces;
// interior faces always render.
//
// textureAlign picks how each face maps the tile:
//   'world' (default) - UVs project from where the box sits inside a full
//   block, as if the texture were painted on the unit cube and the box
//   cut out of it (a lower-half slab samples the lower half of the tile).
//   top/bottom/left/right combos - anchor the sampled region to that
//   corner instead, keeping 1:1 texel density (no stretching).
function emitBoxPart(group, world, gx, gy, gz, cx, cy, cz, blockType, box, partIndex) {
    const lx1 = box[0], ly1 = box[1], lz1 = box[2];
    const lx2 = box[3], ly2 = box[4], lz2 = box[5];
    const x1 = lx1 * 2, y1 = ly1 * 2, z1 = lz1 * 2;
    const x2 = lx2 * 2, y2 = ly2 * 2, z2 = lz2 * 2;
    if (x1 === x2 || y1 === y2 || z1 === z2) return;

    const ex = lx2 - lx1;
    const ey = ly2 - ly1;
    const ez = lz2 - lz1;
    const align = blocks.textureAlign(blockType);
    const useAO = blocks.ambientOcclusion(blockType);

    const uvRect = (uExt, vExt, uWorld, vWorld) => {
        const u0 = align.u === 'left' ? 0
            : align.u === 'right' ? 1 - uExt : uWorld;
        const v0 = align.v === 'top' ? 0
            : align.v === 'bottom' ? 1 - vExt : vWorld;
        return [u0, u0 + uExt, v0, v0 + vExt];
    };

    let uv;
    const faces = [];

    uv = uvRect(ex, ey, lx1 + 0.5, 0.5 - ly2);
    faces.push({ dir: [ 0, 0, 1], edge: z2, max: true,  norm: [0,0, 1],
        corners: [[x1,y1,z2,uv[0],uv[3]],[x2,y1,z2,uv[1],uv[3]],[x2,y2,z2,uv[1],uv[2]],[x1,y2,z2,uv[0],uv[2]]] });
    uv = uvRect(ex, ey, 0.5 - lx2, 0.5 - ly2);
    faces.push({ dir: [ 0, 0,-1], edge: z1, max: false, norm: [0,0,-1],
        corners: [[x2,y1,z1,uv[0],uv[3]],[x1,y1,z1,uv[1],uv[3]],[x1,y2,z1,uv[1],uv[2]],[x2,y2,z1,uv[0],uv[2]]] });
    uv = uvRect(ex, ez, lx1 + 0.5, lz1 + 0.5);
    faces.push({ dir: [ 0, 1, 0], edge: y2, max: true,  norm: [0, 1,0],
        corners: [[x1,y2,z2,uv[0],uv[3]],[x2,y2,z2,uv[1],uv[3]],[x2,y2,z1,uv[1],uv[2]],[x1,y2,z1,uv[0],uv[2]]] });
    uv = uvRect(ex, ez, lx1 + 0.5, 0.5 - lz2);
    faces.push({ dir: [ 0,-1, 0], edge: y1, max: false, norm: [0,-1,0],
        corners: [[x1,y1,z1,uv[0],uv[3]],[x2,y1,z1,uv[1],uv[3]],[x2,y1,z2,uv[1],uv[2]],[x1,y1,z2,uv[0],uv[2]]] });
    uv = uvRect(ez, ey, 0.5 - lz2, 0.5 - ly2);
    faces.push({ dir: [ 1, 0, 0], edge: x2, max: true,  norm: [ 1,0,0],
        corners: [[x2,y1,z2,uv[0],uv[3]],[x2,y1,z1,uv[1],uv[3]],[x2,y2,z1,uv[1],uv[2]],[x2,y2,z2,uv[0],uv[2]]] });
    uv = uvRect(ez, ey, lz1 + 0.5, 0.5 - ly2);
    faces.push({ dir: [-1, 0, 0], edge: x1, max: false, norm: [-1,0,0],
        corners: [[x1,y1,z1,uv[0],uv[3]],[x1,y1,z2,uv[1],uv[3]],[x1,y2,z2,uv[1],uv[2]],[x1,y2,z1,uv[0],uv[2]]] });

    for (let f = 0; f < faces.length; f++) {
        const face = faces[f];

        const onBoundary = face.max
            ? face.edge >= 1 - BOX_EPS
            : face.edge <= -1 + BOX_EPS;
        if (onBoundary) {
            const nType = safeGetType(world,
                gx + face.dir[0], gy + face.dir[1], gz + face.dir[2]);
            if (nType !== -1 && (nType === blockType || !blocks.actsTransparent(nType))) continue;
        }

        pushFace(group, world, face, gx, gy, gz, cx, cy, cz,
            blocks.faceLayer(blockType, f, partIndex), false, useAO);
    }
}

// Two crossed quads for a 'plant' renderType block, double-sided.
// Each quad is emitted twice: front as-authored, then reversed-winding
// with mirrored U, so the texture reads correctly from either side.
// With ambientOcclusion enabled, corners darken based on the horizontal
// neighbours around the plant cell.
function emitPlantCross(group, cx, cy, cz, layer, world, gx, gy, gz, useAO) {
    const AO = [1.0, 0.72, 0.48, 0.25];
    for (const quad of PLANT_QUADS) {
        let factors = null;
        if (useAO) {
            factors = quad.map((c) => {
                const dx = c[0] > 0 ? 1 : -1;
                const dz = c[2] > 0 ? 1 : -1;
                const s1 = safeHas(world, gx + dx, gy, gz) ? 1 : 0;
                const s2 = safeHas(world, gx, gy, gz + dz) ? 1 : 0;
                const cb = safeHas(world, gx + dx, gy, gz + dz) ? 1 : 0;
                return AO[(s1 && s2) ? 3 : (s1 + s2 + cb)];
            });
        }
        for (let side = 0; side < 2; side++) {
            const back = side === 1;
            const order = back ? [3, 2, 1, 0] : [0, 1, 2, 3];
            const base = group.vc;
            for (const i of order) {
                const c = quad[i];
                group.vertices.push(
                    cx + c[0], cy + c[1], cz + c[2],
                    (back ? 1 - c[3] : c[3]) ? 1 - PAD_UV : PAD_UV,
                    c[4] ? 1 - PAD_UV : PAD_UV,
                    0, 1, 0,
                    factors ? factors[i] : 1.0, layer
                );
            }
            group.indices.push(
                base + 0, base + 1, base + 2,
                base + 0, base + 2, base + 3
            );
            group.vc += 4;
        }
    }
}

// Unit cube (extent ±1, positions only, 24 verts / 36 indices).
// Used for the additive glow drawn around the targeted block.
export function buildUnitCubeMesh() {
    const vertices = [];
    const indices  = [];
    let vc = 0;
    for (const face of FACES) {
        for (const corner of face.corners) {
            vertices.push(corner[0], corner[1], corner[2]);
        }
        indices.push(
            vc + 0, vc + 1, vc + 2,
            vc + 0, vc + 2, vc + 3
        );
        vc += 4;
    }
    return {
        vertices: new Float32Array(vertices),
        indices:  new Uint16Array(indices),
        indexCount: 36
    };
}

// Block type at world coords, or -1 for air / missing chunk.
// Reads the voxel map directly so absent cells are distinguishable
// from Chunk.get()'s stone default.
function safeGetType(world, x, y, z) {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const chunk = world.chunks.get(`${cx},${cz}`);
    if (!chunk) return -1;

    const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const lz = ((z % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const t = chunk.voxels.get(`${lx},${y},${lz}`);
    return t === undefined ? -1 : t;
}

// Occluder test for AO: actsTransparent blocks do not darken corners
function safeHas(world, x, y, z) {
    const t = safeGetType(world, x, y, z);
    return t !== -1 && !blocks.actsTransparent(t);
}

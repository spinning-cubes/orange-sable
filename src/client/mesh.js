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
                blocks.faceLayer(blockType, 0));
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
                blocks.faceLayer(blockType, f), isWater);
        }
    }

    return {
        vertices: opaque.vertices, indices: opaque.indices, indexCount: opaque.indices.length,
        cutoutVertices: cutout.vertices, cutoutIndices: cutout.indices, cutoutIndexCount: cutout.indices.length,
        blendVertices: blend.vertices, blendIndices: blend.indices, blendIndexCount: blend.indices.length
    };
}

// Emit one quad (4 verts + indices) with per-corner AO. `face.corners`
// entries are [x, y, z, u, v] offsets from the block centre; u/v are 0/1.
function pushFace(group, world, face, gx, gy, gz, cx, cy, cz, textureOffset, lowerTop) {
    const aoLevels = [];

    for (let c = 0; c < 4; c++) {
        const corner = face.corners[c];
        const dx = corner[0], dy = corner[1], dz = corner[2];

        let s1 = 0, s2 = 0, cornerBlock = 0;
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
// UVs keep the texel density of a full 1x1x1 block face: every face
// samples a top-left anchored region sized to its own fractional extent
// instead of stretching the tile to fit, as if the texture were painted
// on the unit cube and the box cut out of it.
function emitBoxPart(group, world, gx, gy, gz, cx, cy, cz, blockType, box, partIndex) {
    const x1 = box[0] * 2, y1 = box[1] * 2, z1 = box[2] * 2;
    const x2 = box[3] * 2, y2 = box[4] * 2, z2 = box[5] * 2;
    if (x1 === x2 || y1 === y2 || z1 === z2) return;

    const ex = box[3] - box[0];
    const ey = box[4] - box[1];
    const ez = box[5] - box[2];

    const faces = [
        { dir: [ 0, 0, 1], edge: z2, max: true,  corners: [[x1,y1,z2, 0, ey],[x2,y1,z2, ex, ey],[x2,y2,z2, ex, 0],[x1,y2,z2, 0, 0]], norm: [0,0, 1] },
        { dir: [ 0, 0,-1], edge: z1, max: false, corners: [[x2,y1,z1, 0, ey],[x1,y1,z1, ex, ey],[x1,y2,z1, ex, 0],[x2,y2,z1, 0, 0]], norm: [0,0,-1] },
        { dir: [ 0, 1, 0], edge: y2, max: true,  corners: [[x1,y2,z2, 0, ez],[x2,y2,z2, ex, ez],[x2,y2,z1, ex, 0],[x1,y2,z1, 0, 0]], norm: [0, 1,0] },
        { dir: [ 0,-1, 0], edge: y1, max: false, corners: [[x1,y1,z1, 0, ez],[x2,y1,z1, ex, ez],[x2,y1,z2, ex, 0],[x1,y1,z2, 0, 0]], norm: [0,-1,0] },
        { dir: [ 1, 0, 0], edge: x2, max: true,  corners: [[x2,y1,z2, 0, ey],[x2,y1,z1, ez, ey],[x2,y2,z1, ez, 0],[x2,y2,z2, 0, 0]], norm: [ 1,0,0] },
        { dir: [-1, 0, 0], edge: x1, max: false, corners: [[x1,y1,z1, 0, ey],[x1,y1,z2, ex, ey],[x1,y2,z2, ex, 0],[x1,y2,z1, 0, 0]], norm: [-1,0,0] }
    ];

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
            blocks.faceLayer(blockType, f, partIndex), false);
    }
}

// Two crossed quads for a 'plant' renderType block, double-sided.
// Each quad is emitted twice: front as-authored, then reversed-winding
// with mirrored U, so the texture reads correctly from either side.
function emitPlantCross(group, cx, cy, cz, layer) {
    for (const quad of PLANT_QUADS) {
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
                    1.0, layer
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

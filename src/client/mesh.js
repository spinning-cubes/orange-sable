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

// Fluid surfaces sit slightly below the block top (Minecraft-style lip)
const WATER_DROP = 2 * (1 / 16);

// Build mesh for a single chunk.  The `world` object is used for
// cross-chunk neighbor lookups (face culling + AO).
// Vertex layout: position(3) + texCoord(2) + normal(3) + ao(1) + layer(1) = 10 floats.
// Transparent blocks (water) are emitted into separate buffers so they can
// be drawn in a blended pass after the opaque geometry.
export function buildChunkMesh(world, chunk) {
    const vertices = [];
    const indices  = [];
    let vertexCount = 0;
    const waterVertices = [];
    const waterIndices  = [];
    let waterVertexCount = 0;

    const OX = chunk.cx * CHUNK_SIZE;
    const OZ = chunk.cz * CHUNK_SIZE;

    for (const [lx, ly, lz] of chunk) {
        const gx = OX + lx;
        const gz = OZ + lz;
        const cx = gx * 2.0, cy = ly * 2.0, cz = gz * 2.0;
        const blockType = chunk.get(lx, ly, lz);
        const isWater = blocks.isFluid(blockType);

        for (let f = 0; f < FACES.length; f++) {
            const face = FACES[f];
            const nx = gx + face.dir[0];
            const ny = ly + face.dir[1];
            const nz = gz + face.dir[2];

            // Face culling: hidden behind missing chunks never happens
            // (-1 = air). A face is skipped when the neighbour is opaque or
            // is the same transparent type (no internal water faces).
            const nType = safeGetType(world, nx, ny, nz);
            if (nType !== -1 && (nType === blockType || !blocks.isTransparent(nType))) continue;

            const aoLevels = [];
            const textureOffset = blocks.faceLayer(blockType, f);

            for (let c = 0; c < 4; c++) {
                const corner = face.corners[c];
                const dx = corner[0], dy = corner[1], dz = corner[2];

                let s1 = 0, s2 = 0, cornerBlock = 0;
                if (face.dir[0] !== 0) {
                    const fnx = face.dir[0];
                    s1 = safeHas(world, gx + fnx, ly + dy, gz) ? 1 : 0;
                    s2 = safeHas(world, gx + fnx, ly, gz + dz) ? 1 : 0;
                    cornerBlock = safeHas(world, gx + fnx, ly + dy, gz + dz) ? 1 : 0;
                } else if (face.dir[1] !== 0) {
                    const fny = face.dir[1];
                    s1 = safeHas(world, gx + dx, ly + fny, gz) ? 1 : 0;
                    s2 = safeHas(world, gx, ly + fny, gz + dz) ? 1 : 0;
                    cornerBlock = safeHas(world, gx + dx, ly + fny, gz + dz) ? 1 : 0;
                } else {
                    const fnz = face.dir[2];
                    s1 = safeHas(world, gx + dx, ly, gz + fnz) ? 1 : 0;
                    s2 = safeHas(world, gx, ly + dy, gz + fnz) ? 1 : 0;
                    cornerBlock = safeHas(world, gx + dx, ly + dy, gz + fnz) ? 1 : 0;
                }

                const aoLevel = (s1 && s2) ? 3 : (s1 + s2 + cornerBlock);
                const aoFactor = [1.0, 0.72, 0.48, 0.25][aoLevel];
                aoLevels.push(aoLevel);

                // Tile-local UV + texture array layer
                const texU = corner[3] ? 1 - PAD_UV : PAD_UV;
                const texV = corner[4] ? 1 - PAD_UV : PAD_UV;

                // Lower every water vertex that sits at the block top
                const vy = (isWater && dy === 1) ? cy + 1 - WATER_DROP : cy + dy;

                const target = isWater ? waterVertices : vertices;
                target.push(
                    cx + corner[0], vy, cz + corner[2],
                    texU, texV,
                    face.norm[0], face.norm[1], face.norm[2],
                    aoFactor, textureOffset
                );
            }

            const idxTarget   = isWater ? waterIndices : indices;
            const base        = isWater ? waterVertexCount : vertexCount;

            // Flip quad to keep AO seams smooth.
            if (aoLevels[0] + aoLevels[2] > aoLevels[1] + aoLevels[3]) {
                idxTarget.push(
                    base + 1, base + 2, base + 3,
                    base + 1, base + 3, base + 0
                );
            } else {
                idxTarget.push(
                    base + 0, base + 1, base + 2,
                    base + 0, base + 2, base + 3
                );
            }
            if (isWater) waterVertexCount += 4;
            else vertexCount += 4;
        }
    }

    return {
        vertices, indices, indexCount: indices.length,
        waterVertices, waterIndices, waterIndexCount: waterIndices.length
    };
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

// Occluder test for AO: transparent blocks (water) do not darken corners
function safeHas(world, x, y, z) {
    const t = safeGetType(world, x, y, z);
    return t !== -1 && !blocks.isTransparent(t);
}

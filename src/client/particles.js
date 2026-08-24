// Each particle is a camera-facing quad sampling a random 4×4 pixel
// region of the 16×16 block texture.  Per-vertex data (9 floats):
//   centerPos(3) + cornerOffset(2) + texCoord(2) + size(1) + blockType(1)

const CORNERS = [
    // offsetX, offsetY, texU, texV  (0 or 1 — multiplied by texSize)
    [-0.5, -0.5, 0, 0],
    [ 0.5, -0.5, 1, 0],
    [ 0.5,  0.5, 1, 1],
    [-0.5,  0.5, 0, 1]
];
const QUAD_INDICES = [0, 1, 2, 0, 2, 3];

const TEX_PX  = 16;   // texture is 16×16
const SECT_PX = 4;    // sample a 4×4 region

export function createParticleSystem(maxParticles = 600) {
    return {
        particles: [],
        max: maxParticles,
        buffer:  new Float32Array(maxParticles * 4 * 9),
        indices:  new Uint16Array(maxParticles * 6)
    };
}

export function spawnBreakParticles(ps, gx, gy, gz, blockType = 0) {
    const cx = gx * 2, cy = gy * 2, cz = gz * 2;
    for (let i = 0; i < 16; i++) {
        if (ps.particles.length >= ps.max) ps.particles.shift();
        const life = 0.7 + Math.random() * 0.5;
        // Random 4×4 section of the 16×16 texture.
        const tu = Math.floor(Math.random() * (TEX_PX - SECT_PX + 1));
        const tv = Math.floor(Math.random() * (TEX_PX - SECT_PX + 1));
        ps.particles.push({
            pos: [
                cx + (Math.random() - 0.5) * 1.6,
                cy + (Math.random() - 0.5) * 1.6,
                cz + (Math.random() - 0.5) * 1.6
            ],
            vel: [
                (Math.random() - 0.5) * 5,
                Math.random() * 4 + 2.5,
                (Math.random() - 0.5) * 5
            ],
            life,
            maxLife: life,
            texU:    tu / TEX_PX,
            texV:    tv / TEX_PX,
            texSize: SECT_PX / TEX_PX,
            size:    0.3 + Math.random() * 0.2,
            blockType: blockType // Store block type for texture selection
        });
    }
}

export function updateParticles(ps, dt) {
    for (let i = ps.particles.length - 1; i >= 0; i--) {
        const p = ps.particles[i];
        p.life -= dt;
        if (p.life <= 0) { ps.particles.splice(i, 1); continue; }
        p.vel[1] -= 40 * dt;
        p.pos[0] += p.vel[0] * dt;
        p.pos[1] += p.vel[1] * dt;
        p.pos[2] += p.vel[2] * dt;
    }
}

export function buildParticleBuffer(ps) {
    const n   = ps.particles.length;
    const buf = ps.buffer;
    const idx = ps.indices;

    for (let i = 0; i < n; i++) {
        const p    = ps.particles[i];
        const vBase = i * 36;             // 4 verts × 9 floats

        for (let c = 0; c < 4; c++) {
            const off = vBase + c * 9;
            buf[off]     = p.pos[0];                                   // centerX
            buf[off + 1] = p.pos[1];                                   // centerY
            buf[off + 2] = p.pos[2];                                   // centerZ
            buf[off + 3] = CORNERS[c][0];                              // offsetX
            buf[off + 4] = CORNERS[c][1];                              // offsetY
            buf[off + 5] = p.texU + CORNERS[c][2] * p.texSize;         // texU
            buf[off + 6] = p.texV + CORNERS[c][3] * p.texSize;         // texV
            buf[off + 7] = p.size;                                    // size
            buf[off + 8] = p.blockType || 0;                           // blockType
        }

        const iBase = i * 6;
        const vIdx  = i * 4;
        for (let c = 0; c < 6; c++) idx[iBase + c] = vIdx + QUAD_INDICES[c];
    }
    return n;
}
// Classic 2D Perlin noise with seeded permutation table.
// Returns values in roughly [-1, 1].

const GRAD2 = [
    [ 1, 0], [-1, 0], [ 0, 1], [ 0,-1],
    [ 1, 1], [-1, 1], [ 1,-1], [-1,-1]
];

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + t * (b - a); }
function dot2(g, x, y) { return g[0] * x + g[1] * y; }

export class PerlinNoise {
    constructor(seed = 42) {
        this.perm = new Uint8Array(512);
        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) p[i] = i;
        // Seeded Fisher-Yates shuffle
        let s = seed;
        for (let i = 255; i > 0; i--) {
            s = (s * 16807 + 0) % 2147483647;
            const j = s % (i + 1);
            const tmp = p[i]; p[i] = p[j]; p[j] = tmp;
        }
        for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    }

    noise2D(x, y) {
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;
        const xf = x - Math.floor(x);
        const yf = y - Math.floor(y);
        const u = fade(xf);
        const v = fade(yf);
        const p = this.perm;

        const aa = p[p[X] + Y] & 7;
        const ab = p[p[X] + Y + 1] & 7;
        const ba = p[p[X + 1] + Y] & 7;
        const bb = p[p[X + 1] + Y + 1] & 7;

        return lerp(
            lerp(dot2(GRAD2[aa], xf, yf),     dot2(GRAD2[ba], xf - 1, yf), u),
            lerp(dot2(GRAD2[ab], xf, yf - 1), dot2(GRAD2[bb], xf - 1, yf - 1), u),
            v
        );
    }

    // Multi-octave fractal noise.
    // octaves: number of layers.  persistence: amplitude multiplier per octave.
    // lacunarity: frequency multiplier per octave.
    fbm(x, y, octaves = 4, persistence = 0.5, lacunarity = 2.0) {
        let total = 0;
        let amplitude = 1.0;
        let frequency = 1.0;
        let maxVal = 0;
        for (let i = 0; i < octaves; i++) {
            total += this.noise2D(x * frequency, y * frequency) * amplitude;
            maxVal += amplitude;
            amplitude *= persistence;
            frequency *= lacunarity;
        }
        return total / maxVal;
    }
}

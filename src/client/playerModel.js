// Player avatar model loader.
//
// Loads a small Wavefront OBJ (+ its MTL diffuse texture) exported from
// Blockbench and uploads it as an interleaved buffer that reuses the chunk
// vertex layout (pos3 uv2 normal3 ao1 layer1) so the regular voxel shader
// can render it - AO is baked to 1.0 and the texture layer to 0, with the
// skin living on layer 0 of a private single-layer TEXTURE_2D_ARRAY.
//
// Requires WebGL2 (sampler2DArray); loadPlayerModel resolves to null on
// WebGL1 and third-person views simply draw without the avatar.

// Parse the subset of OBJ Blockbench emits: v / vt / vn / f lines with
// v/vt/vn corner indices (any component optional, negatives relative).
// Polygon faces are fan-triangulated.
function parseOBJ(text) {
    const positions = [];
    const uvs = [];
    const normals = [];
    // Flat list of [vi, ti, ni] corner refs in final triangle order
    const corners = [];

    for (let raw of text.split(/\r?\n/)) {
        raw = raw.trim();
        if (!raw || raw.startsWith('#')) continue;
        const parts = raw.split(/\s+/);
        if (parts[0] === 'v') {
            positions.push([+parts[1], +parts[2], +parts[3]]);
        } else if (parts[0] === 'vt') {
            uvs.push([+parts[1], +parts[2]]);
        } else if (parts[0] === 'vn') {
            normals.push([+parts[1], +parts[2], +parts[3]]);
        } else if (parts[0] === 'f') {
            const resolved = parts.slice(1).map((tok) => {
                const seg = tok.split('/');
                const vi = parseInt(seg[0], 10);
                const ti = seg.length > 1 && seg[1] ? parseInt(seg[1], 10) : 0;
                const ni = seg.length > 2 && seg[2] ? parseInt(seg[2], 10) : 0;
                return [
                    vi < 0 ? positions.length + vi : vi - 1,
                    ti < 0 ? uvs.length + ti : ti - 1,
                    ni < 0 ? normals.length + ni : ni - 1
                ];
            });
            for (let i = 1; i + 1 < resolved.length; i++) {
                corners.push(resolved[0], resolved[i], resolved[i + 1]);
            }
        }
    }
    return { positions, uvs, normals, corners };
}

function parseMTLMapKd(text) {
    for (const raw of text.split(/\r?\n/)) {
        const parts = raw.trim().split(/\s+/);
        if (parts[0] === 'map_Kd' && parts[1]) return parts[1];
    }
    return null;
}

// Interleave the parsed OBJ into the voxel vertex layout. Texture V is
// flipped because OBJ uv space is bottom-left origin while our textures are
// uploaded top-row-first (no UNPACK_FLIP_Y anywhere in this engine).
function buildInterleaved(parsed) {
    const { positions, uvs, normals, corners } = parsed;
    const data = new Float32Array(corners.length * 10);

    for (let k = 0; k < corners.length; k++) {
        const [vi, ti, ni] = corners[k];
        const p = positions[vi];
        const t = ti >= 0 && ti < uvs.length ? uvs[ti] : null;
        const n = ni >= 0 && ni < normals.length ? normals[ni] : null;

        let nx = 0, ny = 1, nz = 0;
        if (n) {
            nx = n[0]; ny = n[1]; nz = n[2];
        } else if (k % 3 === 2) {
            // Missing normal on this face: derive a flat normal for the
            // whole triangle from its cross product.
            const a = positions[corners[k - 2][0]];
            const b = positions[corners[k - 1][0]];
            const c = p;
            const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
            const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
            nx = uy * vz - uz * vy;
            ny = uz * vx - ux * vz;
            nz = ux * vy - uy * vx;
            const len = Math.hypot(nx, ny, nz) || 1;
            nx /= len; ny /= len; nz /= len;
            for (let j = k - 2; j <= k; j++) {
                data[j * 10 + 5] = nx;
                data[j * 10 + 6] = ny;
                data[j * 10 + 7] = nz;
            }
        }

        const o = k * 10;
        data[o]     = p[0];
        data[o + 1] = p[1];
        data[o + 2] = p[2];
        data[o + 3] = t ? t[0] : 0;
        data[o + 4] = t ? 1 - t[1] : 0;
        data[o + 5] = nx;
        data[o + 6] = ny;
        data[o + 7] = nz;
        data[o + 8] = 1;   // AO: fully lit
        data[o + 9] = 0;   // texture layer 0 of the private skin array
    }
    return data;
}

// Model-space vertical extent (feet y=0 .. head top), used by main.js to
// scale the avatar to the player's collision height.
function modelHeight(positions) {
    let min = Infinity, max = -Infinity;
    for (const p of positions) {
        min = Math.min(min, p[1]);
        max = Math.max(max, p[1]);
    }
    return max - min || 1;
}

function createSkinTexture(gl, imageUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const target = gl.TEXTURE_2D_ARRAY;
            const texture = gl.createTexture();
            gl.bindTexture(target, texture);
            gl.texImage3D(target, 0, gl.RGBA,
                img.width, img.height, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texSubImage3D(target, 0, 0, 0, 0,
                img.width, img.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, img);
            gl.generateMipmap(target);
            gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
            gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            resolve({ texture, target });
        };
        img.onerror = () => reject(new Error(`player skin failed to load: ${imageUrl}`));
        img.src = imageUrl;
    });
}

export async function loadPlayerModel(gl, { obj, mtl }) {
    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' &&
        gl instanceof WebGL2RenderingContext;
    if (!isWebGL2) {
        console.warn('[client] player avatar needs WebGL2 - third-person body disabled');
        return null;
    }

    const fetchText = (url) => fetch(url).then((r) => {
        if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
        return r.text();
    });

    const [objText, mtlText] = await Promise.all([
        fetchText(obj),
        fetchText(mtl).catch(() => '')
    ]);

    const parsed = parseOBJ(objText);
    if (parsed.corners.length === 0) {
        throw new Error('player.obj contains no faces');
    }

    const data = buildInterleaved(parsed);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    // Every interleaved corner is unique - indices are just 0..n-1
    const indexCount = parsed.corners.length;
    const seq = new Uint16Array(indexCount);
    for (let i = 0; i < indexCount; i++) seq[i] = i;
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, seq, gl.STATIC_DRAW);

    const mapKd = parseMTLMapKd(mtlText);
    // Vite ?url imports can be root-relative paths, so anchor them on
    // location.href before resolving the texture name against the mtl dir.
    const mtlUrl = new URL(mtl, location.href);
    const texUrl = mapKd ? new URL(mapKd, mtlUrl).href : null;
    if (!texUrl) throw new Error('player.mtl has no map_Kd diffuse texture');

    const texture = await createSkinTexture(gl, texUrl);

    return {
        vbo, ibo, indexCount, texture,
        height: modelHeight(parsed.positions)
    };
}

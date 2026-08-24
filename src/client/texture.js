// Block textures are defined by mods; the ordered URL list arrives in the
// server's manifest and each index becomes a WebGL2 TEXTURE_2D_ARRAY layer
// (each tile mips independently - no atlas bleed), falling back to a
// horizontal atlas texture on WebGL1. Returns { texture, target, isWebGL2 }.
export function createTextureAtlas(gl, urls) {
    const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' &&
        gl instanceof WebGL2RenderingContext;
    const target = isWebGL2 ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;
    const texture = gl.createTexture();
    gl.bindTexture(target, texture);

    const images = urls.map((src) => ({ src, loaded: false }));

    let loadedCount = 0;
    const SIZE = 16;

    function checkAllLoaded() {
        if (loadedCount !== images.length) return;
        gl.bindTexture(target, texture);

        if (isWebGL2) {
            // One independent layer per block texture
            const scratch = document.createElement('canvas');
            scratch.width = SIZE;
            scratch.height = SIZE;
            const sctx = scratch.getContext('2d');
            images.forEach((img, i) => {
                sctx.clearRect(0, 0, SIZE, SIZE);
                sctx.drawImage(img.element, 0, 0);
                gl.texSubImage3D(target, 0, 0, 0, i, SIZE, SIZE, 1,
                    gl.RGBA, gl.UNSIGNED_BYTE, scratch);
            });
            // Layers mip independently, so distant terrain cannot bleed
            // between tiles. NEAREST mag keeps the pixel-art look up close.
            gl.generateMipmap(target);
            gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR);
            const anisoExt = gl.getExtension('EXT_texture_filter_anisotropic');
            if (anisoExt) {
                const maxAniso = gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
                gl.texParameterf(target, anisoExt.TEXTURE_MAX_ANISOTROPY_EXT,
                    Math.min(4, maxAniso));
            }
        } else {
            // WebGL1 fallback atlas: one row of tiles. No mipmaps -
            // mipmapping a shared atlas blends neighbouring tiles together.
            const canvas = document.createElement('canvas');
            canvas.width = SIZE * images.length;
            canvas.height = SIZE;
            const ctx = canvas.getContext('2d');
            images.forEach((img, i) => {
                ctx.drawImage(img.element, i * SIZE, 0);
            });
            gl.texImage2D(target, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        }

        gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    images.forEach((img) => {
        const image = new Image();
        image.src = img.src;
        image.onload = () => {
            img.element = image;
            img.loaded = true;
            loadedCount++;
            checkAllLoaded();
        };
    });

    // Valid placeholder content while the images load
    if (isWebGL2) {
        gl.texImage3D(target, 0, gl.RGBA, SIZE, SIZE, Math.max(1, images.length), 0,
            gl.RGBA, gl.UNSIGNED_BYTE, null);
    } else {
        const data = new Uint8Array(SIZE * SIZE * 4);
        for (let i = 0; i < data.length; i += 4) {
            data[i] = 120;
            data[i + 1] = 120;
            data[i + 2] = 114;
            data[i + 3] = 255;
        }
        gl.texImage2D(target, 0, gl.RGBA, SIZE, SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    return { texture, target, isWebGL2 };
}

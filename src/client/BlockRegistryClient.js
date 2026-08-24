// Client mirror of the server's block registry. The integrated server
// compiles every modded block into a JSON manifest and sends it on connect;
// this class consumes it and answers everything the renderer needs:
// id lookups, per-face atlas layers, transparency/fluid flags.
//
// Before the manifest arrives every query degrades safely (opaque, layer 0),
// so no caller needs to special-case the loading window.
export class BlockRegistryClient {
    constructor() {
        this.ready = false;
        this.blocks = [];       // manifest entries; array index = block id
        this.textureUrls = [];  // ordered; array index = atlas layer
        this._byName = new Map();
    }

    get maxBlockId() { return this.blocks.length - 1; }

    // Fallback fill for missing voxels (was hardcoded BLOCK_STONE).
    get defaultId() {
        for (const b of this.blocks) {
            if (b.name.endsWith(':stone')) return b.id;
        }
        return 0;
    }

    def(id) { return this.blocks[id] || null; }

    id(name) {
        const def = this._byName.get(name);
        return def ? def.id : -1;
    }

    isTransparent(id) {
        const def = this.def(id);
        return !!def && def.isTransparent;
    }

    isFluid(id) {
        const def = this.def(id);
        return !!def && def.isFluid;
    }

    // Atlas layer for a block face. faceIndex follows mesh.js FACES order:
    // 2 = top (+y), 3 = bottom (-y), everything else is a side face.
    faceLayer(id, faceIndex) {
        const def = this.def(id);
        if (!def) return 0;
        if (faceIndex === 2) return def.textures.top;
        if (faceIndex === 3) return def.textures.bottom;
        return def.textures.side;
    }

    particleLayer(id) {
        const def = this.def(id);
        return def ? def.particle : 0;
    }

    loadManifest(manifest) {
        if (!manifest || !Array.isArray(manifest.blocks) ||
            !Array.isArray(manifest.textures)) {
            throw new Error('[block-registry] malformed manifest received');
        }
        this.blocks = manifest.blocks;
        this.textureUrls = manifest.textures;
        this._byName = new Map(this.blocks.map((b) => [b.name, b]));
        this.ready = true;
        console.log(`[block-registry] manifest applied: ` +
            `${this.blocks.length} blocks, ${this.textureUrls.length} textures`);
    }
}

export const blocks = new BlockRegistryClient();

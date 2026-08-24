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

    actsTransparent(id) {
        const def = this.def(id);
        return !!def && !!(def.actsTransparent ?? def.isTransparent);
    }

    isFluid(id) {
        const def = this.def(id);
        return !!def && def.isFluid;
    }

    isSolid(id) {
        const def = this.def(id);
        return !!def && def.isSolid !== false;
    }

    renderType(id) {
        const def = this.def(id);
        return (def && def.renderType) || 'node';
    }

    isPlant(id) {
        return this.renderType(id) === 'plant';
    }

    transparentType(id) {
        const def = this.def(id);
        if (!def) return 'cutout';
        if (def.transparentType) return def.transparentType;
        return def.isFluid ? 'blend' : 'cutout';
    }

    // Atlas layer for a block face. faceIndex follows mesh.js FACES order:
    // 2 = top (+y), 3 = bottom (-y), everything else is a side face.
    // Nodebox blocks take a part index into def.nodebox for per-part layers.
    faceLayer(id, faceIndex, partIndex) {
        const def = this.def(id);
        if (!def) return 0;
        if (Array.isArray(def.nodebox)) {
            const part = def.nodebox[partIndex];
            if (part && part.textures) {
                if (faceIndex === 2) return part.textures.top;
                if (faceIndex === 3) return part.textures.bottom;
                return part.textures.side;
            }
        }
        if (faceIndex === 2) return def.textures.top;
        if (faceIndex === 3) return def.textures.bottom;
        return def.textures.side;
    }

    nodeboxParts(id) {
        const def = this.def(id);
        return (def && Array.isArray(def.nodebox)) ? def.nodebox : null;
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

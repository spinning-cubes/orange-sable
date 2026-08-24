// Server-side block registry: loads every mod under ./mods/<name>/init.js,
// collects their block definitions, and compiles them into the JSON manifest
// shipped to clients. Numeric block ids are assigned in registration order,
// which is deterministic because mod modules are imported sorted by path.
//
// Mods are written against a `main` global (see mods/main/init.js):
//   main.setModNamespace = "<ns>"
//   main.registerBlock({ name, description, isTransparent, isFluid,
//                        texture(face, x, y, z, world) -> textureName })
// The texture resolver is evaluated once per face here so the manifest can
// stay plain JSON (static layer indices) instead of shipping code.
// Discovered by Vite (dev + build rewrite this call into a static module
// map); outside Vite we fall back to a static list so the game also runs
// from any plain static file server. New mods must be added there too.
let MOD_MODULES = {};
try {
    // Use absolute path from project root
    MOD_MODULES = import.meta.glob('/src/server/mods/*/init.js', { eager: false });
} catch {
    MOD_MODULES = {
        '/src/server/mods/main/init.js': () => import('/src/server/mods/main/init.js')
    };
}
const MOD_ASSET_BASE = '/src/server/mods';

export class BlockRegistryServer {
    constructor(modules = null) {
        this._modules = modules || MOD_MODULES;
        this.blocks = [];       // manifest entries; array index = block id
        this.textureUrls = [];  // ordered; array index = atlas layer
        this.decorations = [];  // worldgen scatters registered by mods
        this._layersByUrl = new Map();
        this._byName = new Map();
        this.manifest = null;
    }

    get maxBlockId() { return this.blocks.length - 1; }

    get defaultId() {
        // Storage treats missing voxels as stone-like filler; pick the mod's
        // ":stone" block when present, otherwise the first solid block.
        for (const b of this.blocks) {
            if (b.name.endsWith(':stone')) return b.id;
        }
        return 0;
    }

    id(name) {
        const def = this._byName.get(name);
        return def ? def.id : -1;
    }

    def(id) { return this.blocks[id] || null; }

    isFluid(id) {
        const def = this.def(id);
        return !!def && def.isFluid;
    }

    async loadMods() {
        const paths = Object.keys(this._modules).sort();
        for (const path of paths) {
            // Glob keys differ by toolchain: relative ('./mods/main/init.js')
            // or absolute ('/src/server/mods/main/init.js'). Always take the
            // segment directly after 'mods'.
            const match = path.match(/\/mods\/([^/]+)\//);
            const modName = match ? match[1] : path.split('/')[2];
            await this.#loadMod(path, modName);
        }
        this.manifest = {
            protocol: 1,
            blocks: this.blocks,
            textures: this.textureUrls
        };
        console.log(`[block-registry] loaded ${this.blocks.length} blocks, ` +
            `${this.textureUrls.length} textures from ${paths.length} mod(s)`);
        return this.manifest;
    }

    async #loadMod(path, modName) {
        const registered = [];
        const registeredDecorations = [];
        const pendingIncludes = [];
        const api = {
            setModNamespace: modName,
            registerBlock(def) { registered.push(def); },
            // Load another JS file from this mod's folder. The promise is
            // tracked so a plain top-level call (no await) still finishes
            // before the manifest is compiled, and `main` stays bound for
            // the included file.
            include(file) {
                const rel = String(file).replace(/^\.\//, '');
                // Resolve against this module's own directory via string
                // surgery: Vite's import/URL analyzers interpret template
                // literals here as glob patterns and reject them.
                const dirUrl = import.meta.url.replace(/[^/]*$/, '');
                const p = import(/* @vite-ignore */ dirUrl + 'mods/' + modName + '/' + rel);
                pendingIncludes.push(p);
                return p;
            },
            registerDecoration(def) { registeredDecorations.push(def); }
        };

        globalThis.main = api;
        try {
            await this._modules[path]();
            // Await inside try: includes must finish while `main` is bound
            await Promise.all(pendingIncludes);
        } finally {
            delete globalThis.main;
        }

        // Mods assign the namespace as a plain property, so read it back
        // after evaluation (assignment replaces our placeholder value).
        const namespace = typeof api.setModNamespace === 'string'
            ? api.setModNamespace : modName;

        // Blocks first - decorations resolve their node against them
        for (const def of registered) {
            this.#registerBlock(namespace, modName, def);
        }
        for (const def of registeredDecorations) {
            this.#registerDecoration(namespace, modName, def);
        }
    }

    #registerBlock(namespace, modName, def) {
        if (!def || typeof def.name !== 'string' || !def.name) {
            throw new Error(`[block-registry] mod '${modName}' registered a block without a name`);
        }
        if (typeof def.texture !== 'function') {
            throw new Error(`[block-registry] block '${namespace}:${def.name}' has no texture(face) resolver`);
        }
        const name = `${namespace}:${def.name}`;
        if (this._byName.has(name)) {
            throw new Error(`[block-registry] duplicate block name '${name}'`);
        }

        const resolve = (face) => {
            let tex;
            try {
                tex = def.texture(face, 0, 0, 0, null);
            } catch (err) {
                throw new Error(`[block-registry] texture resolver for '${name}' failed on face '${face}': ${err.message}`);
            }
            if (typeof tex !== 'string' || !tex) {
                throw new Error(`[block-registry] texture resolver for '${name}' returned no texture name on face '${face}'`);
            }
            return this.#textureLayer(`${MOD_ASSET_BASE}/${modName}/assets/block/${tex}.png`);
        };

        const side = resolve('side');
        const entry = {
            id: this.blocks.length,
            name,
            description: def.description || def.name,
            isTransparent: !!def.isTransparent,
            isFluid: !!def.isFluid,
            textures: {
                top: resolve('top'),
                bottom: resolve('bottom'),
                side
            },
            particle: side
        };

        entry.particle = entry.textures.side;
        this._byName.set(name, entry);
        this.blocks.push(entry);
    }

    // Validate + namespace a decoration registration. Decorations are
    // worldgen scatters (flowers, grass plants, ...): one candidate spot per
    //   spread×spread world cell; `density` [0..1] is the chance the
    // candidate actually spawns; minHeight/maxHeight bound the terrain
    // surface height; biome '*' matches every biome.
    #registerDecoration(namespace, modName, def) {
        if (!def || typeof def.node !== 'string' || !def.node) {
            throw new Error(`[block-registry] mod '${modName}' registered a decoration without a node`);
        }
        const name = def.node.includes(':') ? def.node : `${namespace}:${def.node}`;
        const blockId = this.id(name);
        if (blockId === -1) {
            throw new Error(`[block-registry] decoration node '${name}' (${modName}) is not a registered block`);
        }
        const num = (v, fallback, lo, hi) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return fallback;
            return Math.min(hi, Math.max(lo, n));
        };
        this.decorations.push({
            ordinal: this.decorations.length,
            node: name,
            blockId,
            density: num(def.density, 1, 0, 1),
            minHeight: num(def.minHeight, 0, -Infinity, Infinity),
            maxHeight: num(def.maxHeight, 64, -Infinity, Infinity),
            spread: Math.max(1, Math.floor(num(def.spread, 8, 1, Infinity))),
            biomes: Array.isArray(def.biome)
                ? def.biome.map(String)
                : [String(def.biome ?? '*')]
        });
    }

    #textureLayer(url) {
        if (this._layersByUrl.has(url)) return this._layersByUrl.get(url);
        const layer = this.textureUrls.length;
        this._layersByUrl.set(url, layer);
        this.textureUrls.push(url);
        return layer;
    }
}

export const blockRegistry = new BlockRegistryServer();

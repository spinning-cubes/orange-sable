// Server-side block registry: loads every mod under ./mods/<name>/init.js,
// collects their block definitions, and compiles them into the JSON manifest
// shipped to clients. Numeric block ids are assigned in registration order,
// which is deterministic because mod modules are imported sorted by path.
//
// Mods are written against a `main` global (see mods/main/init.js):
//   main.setModNamespace = "<ns>"
//   main.registerBlock({ name, description, isTransparent, isFluid, isSolid,
//                        actsTransparent,
//                        renderType: 'node' | 'plant' | 'nodebox',
//                        transparentType: 'cutout' | 'blend',
//                        nodebox: [ [id?, x1, y1, z1, x2, y2, z2], ... ],
//                        texture(face, x, y, z, world, part) -> textureName })
// renderType 'plant' draws two crossed quads and implies isTransparent.
// renderType 'nodebox' draws arbitrary boxes per part; the texture
// resolver receives the part id for per-part textures.
// transparentType 'cutout' alpha-discards in the opaque pass; 'blend'
// draws depth-sorted-last with real alpha blending (water-style).
// actsTransparent (implied by isTransparent) only affects occlusion:
// neighbours keep their faces visible against such blocks and they cast
// no AO, while renderType/transparentType stay untouched.
// isSolid defaults to true and is forced false for fluids.
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

    isSolid(id) {
        const def = this.def(id);
        return !!def && def.isSolid !== false;
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
            protocol: 4,
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

        const RENDER_TYPES = ['node', 'plant', 'nodebox'];
        const TRANSPARENT_TYPES = ['cutout', 'blend'];
        const renderType = def.renderType ?? 'node';
        if (!RENDER_TYPES.includes(renderType)) {
            throw new Error(`[block-registry] block '${name}' has invalid renderType '${renderType}' (expected one of: ${RENDER_TYPES.join(', ')})`);
        }
        const transparentType = def.transparentType ?? (def.isFluid ? 'blend' : 'cutout');
        if (!TRANSPARENT_TYPES.includes(transparentType)) {
            throw new Error(`[block-registry] block '${name}' has invalid transparentType '${transparentType}' (expected one of: ${TRANSPARENT_TYPES.join(', ')})`);
        }
        const nodebox = renderType === 'nodebox'
            ? this.#normalizeNodebox(name, modName, def.nodebox)
            : null;

        const resolve = (face, part) => {
            let tex;
            try {
                tex = def.texture(face, 0, 0, 0, null, part ?? null);
            } catch (err) {
                throw new Error(`[block-registry] texture resolver for '${name}' failed on face '${face}'${part ? ` (part '${part}')` : ''}: ${err.message}`);
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
            isTransparent: !!def.isTransparent || renderType === 'plant',
            actsTransparent: !!def.isTransparent || !!def.actsTransparent,
            isFluid: !!def.isFluid,
            isSolid: def.isFluid ? false : def.isSolid ?? true,
            renderType,
            transparentType,
            textures: {
                top: resolve('top'),
                bottom: resolve('bottom'),
                side
            },
            particle: side
        };

        if (nodebox) {
            entry.nodebox = nodebox.map((p) => ({
                name: p.name,
                box: p.box,
                textures: {
                    top: resolve('top', p.name),
                    bottom: resolve('bottom', p.name),
                    side: resolve('side', p.name)
                }
            }));
        }

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

    // Validate + normalize a renderType 'nodebox' definition. Each part is
    // [x1, y1, z1, x2, y2, z2] in -0.5..0.5 block-local units, optionally
    // prefixed with a string part id. Unnamed parts get generated ids;
    // explicit duplicates are rejected.
    #normalizeNodebox(name, modName, raw) {
        if (!Array.isArray(raw) || raw.length === 0) {
            throw new Error(`[block-registry] nodebox block '${name}' (${modName}) needs a non-empty nodebox array`);
        }
        const parts = [];
        const taken = new Set();
        for (let i = 0; i < raw.length; i++) {
            const p = raw[i];
            if (!Array.isArray(p)) {
                throw new Error(`[block-registry] nodebox part ${i} of '${name}' is not an array`);
            }
            let partName = null;
            let nums = p;
            if (typeof p[0] === 'string') {
                partName = p[0];
                nums = p.slice(1);
            }
            if (nums.length !== 6 || !nums.every((n) => Number.isFinite(Number(n)))) {
                throw new Error(`[block-registry] nodebox part '${partName ?? i}' of '${name}' needs 6 numbers (x1, y1, z1, x2, y2, z2)`);
            }
            const [x1, y1, z1, x2, y2, z2] = nums.map(Number);
            const box = [
                Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2),
                Math.max(x1, x2), Math.max(y1, y2), Math.max(z1, z2)
            ];
            if (!partName) {
                let n = 1;
                while (taken.has(`part${n}`)) n++;
                partName = `part${n}`;
            }
            if (taken.has(partName)) {
                throw new Error(`[block-registry] duplicate nodebox part name '${partName}' in '${name}'`);
            }
            taken.add(partName);
            parts.push({ name: partName, box });
        }
        return parts;
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

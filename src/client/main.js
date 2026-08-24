import { Mat4 } from './mat4.js';
import {
    createProgram, VOXEL_VS, VOXEL_FS, GLOW_VS, GLOW_FS,
    PARTICLE_VS, PARTICLE_FS,
    VOXEL_VS_ARRAY, VOXEL_FS_ARRAY,
    PARTICLE_VS_ARRAY, PARTICLE_FS_ARRAY
} from './shaders.js';
import { createTextureAtlas } from './texture.js';
import { blocks } from './BlockRegistryClient.js';
import { buildUnitCubeMesh, buildChunkMesh } from './mesh.js';
import { World, Chunk, CHUNK_SIZE } from './world.js';
import { voxelRaycast } from './raycast.js';
import { createCamera, cameraForward, updateCameraFov } from './camera.js';
import { createPlayer, updatePlayer, playerEyePos, blockOverlapsPlayer, placeOnTerrain, clearKeys } from './player.js';
import { createParticleSystem, spawnBreakParticles, updateParticles, buildParticleBuffer } from './particles.js';
import { frustumPlanes, aabbIntersectsFrustum } from './frustum.js';
import { IsomorphicWebSocket } from '../shared/IsomorphicWebSocket.js';
import { netStats } from './netstats.js';
import DebugOverlay from './gui/DebugOverlay.js';
import IngameMenu from './gui/IngameMenu.js';
import SettingsScreen from './gui/Settings.js';

const canvas = document.getElementById('glCanvas');
const gl = canvas.getContext('webgl2')
        || canvas.getContext('webgl')
        || canvas.getContext('experimental-webgl');

if (!gl) {
    document.body.innerHTML = '<h2 style="color:white;padding:20px;">WebGL not supported</h2>';
    throw new Error('WebGL not supported');
}

// Texture arrays need WebGL2 (sampler2DArray); WebGL1 uses the atlas fallback
const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' &&
    gl instanceof WebGL2RenderingContext;

gl.enable(gl.DEPTH_TEST);
gl.depthFunc(gl.LEQUAL);
gl.enable(gl.CULL_FACE);
gl.cullFace(gl.BACK);

const uintExt       = gl.getExtension('OES_element_index_uint');
const INDEX_TYPE    = uintExt ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
const IndexArrayCtor = uintExt ? Uint32Array : Uint16Array;

// Atlas is built from the server's mod manifest once it arrives
let tex = null;
const voxelProgram      = createProgram(gl, isWebGL2 ? VOXEL_VS_ARRAY : VOXEL_VS,
                                        isWebGL2 ? VOXEL_FS_ARRAY : VOXEL_FS);
const glowProgram       = createProgram(gl, GLOW_VS, GLOW_FS);
const particleProgram   = createProgram(gl, isWebGL2 ? PARTICLE_VS_ARRAY : PARTICLE_VS,
                                        isWebGL2 ? PARTICLE_FS_ARRAY : PARTICLE_FS);

//  Locations 
const voxelAttribs = {
    position: gl.getAttribLocation(voxelProgram, 'aPosition'),
    texCoord: gl.getAttribLocation(voxelProgram, 'aTexCoord'),
    normal:   gl.getAttribLocation(voxelProgram, 'aNormal'),
    ao:       gl.getAttribLocation(voxelProgram, 'aAO'),
    layer:    gl.getAttribLocation(voxelProgram, 'aTexLayer')
};
const voxelUniforms = {
    model:      gl.getUniformLocation(voxelProgram, 'uModel'),
    view:       gl.getUniformLocation(voxelProgram, 'uView'),
    projection: gl.getUniformLocation(voxelProgram, 'uProjection'),
    texture:    gl.getUniformLocation(voxelProgram, 'uTexture'),
    fogColor:   gl.getUniformLocation(voxelProgram, 'uFogColor'),
    fogNear:    gl.getUniformLocation(voxelProgram, 'uFogNear'),
    fogFar:     gl.getUniformLocation(voxelProgram, 'uFogFar')
};
const glowAttribs = { position: gl.getAttribLocation(glowProgram, 'aPosition') };
const glowUniforms = {
    model:      gl.getUniformLocation(glowProgram, 'uModel'),
    view:       gl.getUniformLocation(glowProgram, 'uView'),
    projection: gl.getUniformLocation(glowProgram, 'uProjection'),
    color:      gl.getUniformLocation(glowProgram, 'uColor')
};
const particleAttribs = {
    centerPos: gl.getAttribLocation(particleProgram, 'aCenterPos'),
    offset:    gl.getAttribLocation(particleProgram, 'aOffset'),
    texCoord:  gl.getAttribLocation(particleProgram, 'aTexCoord'),
    size:      gl.getAttribLocation(particleProgram, 'aSize'),
    blockType: gl.getAttribLocation(particleProgram, 'aBlockType')
};
const particleUniforms = {
    view:       gl.getUniformLocation(particleProgram, 'uView'),
    projection: gl.getUniformLocation(particleProgram, 'uProjection'),
    texture:    gl.getUniformLocation(particleProgram, 'uTexture')
};

//  Fog settings 
const FOG_COLOR = [0.427, 0.75, 0.949];

//  Chunk rendering 
const RENDER_DISTANCE_DEFAULT = 10; // chunks (radius)
const RENDER_DISTANCE_MIN = 2;
const RENDER_DISTANCE_MAX = 16;
const RENDER_DISTANCE_KEY = 'sable.renderDistance';

const FOV_DEFAULT = 70;             // degrees
const FOV_MIN = 30;
const FOV_MAX = 110;
const FOV_KEY = 'sable.fov';

function loadSavedNumber(key, fallback, min, max) {
    try {
        const saved = parseInt(localStorage.getItem(key), 10);
        if (Number.isInteger(saved)) {
            return Math.min(max, Math.max(min, saved));
        }
    } catch { /* storage unavailable - fall back to default */ }
    return fallback;
}

let screen = null;  // modal screen (menus, dialogs) - blocks game input
let hud = null;     // persistent HUD layer - stays up behind every screen

// Screens resolve their exit through this host so main's active-screen
// pointer always tracks what is really on display.
const screenHost = {
    onScreenExit(closed) {
        screen = closed.lastScreen || null;
        updateMenuDim();
    }
};

function showScreen(screenClass, ...args) {
    if (screen) {
        screen.view.delete();
    }
    screen = new screenClass(screenHost, screen ?? null, ...args);
    screen.render();
    updateMenuDim();
}

// Close the active modal without touching the persistent HUD.
function closeScreen() {
    if (!screen) return;
    screen.view.delete();
    screen = null;
    updateMenuDim();
}

// HUD screens live outside the modal stack: they are never closed by
// showScreen() and keep rendering while menus are open.
function showHud(screenClass, ...args) {
    if (hud) {
        hud.view.delete();
    }
    hud = new screenClass(screenHost, null, ...args);
    hud.render();
}

// Dim layer shown while a modal is open. Sits above the game canvas and
// the debug HUD (z 99990) but below menu panels (z 99999).
const menuDim = document.createElement('div');
menuDim.style.position = 'fixed';
menuDim.style.inset = '0';
menuDim.style.background = '#000';
menuDim.style.opacity = '0.2';
menuDim.style.pointerEvents = 'none';
menuDim.style.zIndex = '99995';
menuDim.style.display = 'none';
document.body.appendChild(menuDim);

function updateMenuDim() {
    menuDim.style.display = screen ? 'block' : 'none';
}

// Calculate fog distance based on render distance
let renderDistance = loadSavedNumber(RENDER_DISTANCE_KEY,
    RENDER_DISTANCE_DEFAULT, RENDER_DISTANCE_MIN, RENDER_DISTANCE_MAX);
let fovDeg = loadSavedNumber(FOV_KEY, FOV_DEFAULT, FOV_MIN, FOV_MAX);
let RENDER_DISTANCE_UNITS = 0; // Convert chunks to world units
let FOG_NEAR = 0;
let FOG_FAR   = 0;

function applyRenderDistance() {
    RENDER_DISTANCE_UNITS = renderDistance * CHUNK_SIZE * 2;
    FOG_NEAR = RENDER_DISTANCE_UNITS * 0.6;
    FOG_FAR  = RENDER_DISTANCE_UNITS;
}
applyRenderDistance();

function applyFov() {
    camera.baseFov = fovDeg * Math.PI / 180;
}

// Shared setters: clamp, apply immediately, persist. Used by the settings
// screen and the +/- hotkeys alike.
function setRenderDistance(value) {
    const v = Math.round(Number(value));
    if (!Number.isFinite(v)) return;
    const next = Math.min(RENDER_DISTANCE_MAX, Math.max(RENDER_DISTANCE_MIN, v));
    if (next === renderDistance) return;
    renderDistance = next;
    applyRenderDistance();
    // Force updateChunkLoading() to re-evaluate loads/unloads this chunk
    lastPlayerChunkX = null;
    lastPlayerChunkZ = null;
    try { localStorage.setItem(RENDER_DISTANCE_KEY, String(renderDistance)); } catch { }
}

function setFov(value) {
    const v = Math.round(Number(value));
    if (!Number.isFinite(v)) return;
    const next = Math.min(FOV_MAX, Math.max(FOV_MIN, v));
    if (next === fovDeg) return;
    fovDeg = next;
    applyFov();
    try { localStorage.setItem(FOV_KEY, String(fovDeg)); } catch { }
}

// Per-chunk GPU data: { vbo, ibo, indexCount, indexGL, wvbo, wibo, waterIndexCount, waterIndexGL }
const chunkGPU = new Map();

function uploadWorkerMesh(m) {
    const key = m.cx + ',' + m.cz;
    let gpu = chunkGPU.get(key);
    if (!gpu) {
        gpu = {
            vbo: gl.createBuffer(), ibo: gl.createBuffer(), indexCount: 0, indexGL: INDEX_TYPE,
            wvbo: gl.createBuffer(), wibo: gl.createBuffer(), waterIndexCount: 0, waterIndexGL: INDEX_TYPE
        };
        chunkGPU.set(key, gpu);
    }
    const useU32  = m.big && uintExt;
    const indices = useU32 ? new Uint32Array(m.indices) : new Uint16Array(m.indices);
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vbo);
    gl.bufferData(gl.ARRAY_BUFFER,
        m.vertices.length > 0 ? m.vertices : new Float32Array(1),
        gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,
        indices.length > 0 ? indices : new Uint16Array(1),
        gl.DYNAMIC_DRAW);
    gpu.indexCount = m.indexCount;
    gpu.indexGL = useU32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

    const useU32W  = m.waterBig && uintExt;
    const wIndices = useU32W ? new Uint32Array(m.waterIndices) : new Uint16Array(m.waterIndices);
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.wvbo);
    gl.bufferData(gl.ARRAY_BUFFER,
        m.waterVertices.length > 0 ? m.waterVertices : new Float32Array(1),
        gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.wibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,
        wIndices.length > 0 ? wIndices : new Uint16Array(1),
        gl.DYNAMIC_DRAW);
    gpu.waterIndexCount = m.waterIndexCount;
    gpu.waterIndexGL = useU32W ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
}

function deleteChunkGPU(key) {
    const gpu = chunkGPU.get(key);
    if (gpu) {
        gl.deleteBuffer(gpu.vbo);
        gl.deleteBuffer(gpu.ibo);
        gl.deleteBuffer(gpu.wvbo);
        gl.deleteBuffer(gpu.wibo);
        chunkGPU.delete(key);
    }
}

//  World mirror + integrated-server link 
const world = new World(42);

const camera = createCamera(canvas);
const player = createPlayer();

// Apply the persisted FOV once the camera exists
applyFov();

// Debug HUD needs the live player reference for the X/Y/Z readout
showHud(DebugOverlay, { player });

//  Pause menu on pointer-lock loss (Esc, alt-tab, ...) 
function openIngameMenu() {
    // Already paused (menu or its settings open) - nothing to do
    if (screen instanceof IngameMenu || screen instanceof SettingsScreen) return;

    // The menu takes input focus - release whatever was held so movement
    // doesn't continue (or stick) after resume.
    resetInput();

    showScreen(IngameMenu, {
        onResume: () => {
            // Drop the modal first so the lock policy sees gameplay state
            closeScreen();
            requestGameLock();
        },
        onSettings: () => showScreen(SettingsScreen, {
            renderDistance,
            fov: fovDeg,
            onSave: (s) => {
                setRenderDistance(s.renderDistance);
                setFov(s.fov);
            }
        }) // exits back into this menu
    });
}

// Pointer-lock policy: the game may only grab the mouse while no modal
// screen is open. Every acquisition path funnels through here.
function requestGameLock() {
    if (screen) return;
    canvas.requestPointerLock();
}

let pointerWasLocked = false;
document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;

    // Hard enforcement: if a lock slips through (stray call, stale
    // listener, browser quirk) while a menu owns input, kill it again.
    if (locked && screen) {
        document.exitPointerLock();
        return;
    }

    if (pointerWasLocked && !locked) openIngameMenu();
    pointerWasLocked = locked;
});

document.addEventListener('pointerlockerror', () => {
    // A relock request was rejected (browsers enforce a cooldown right
    // after Esc) - drop back into the menu so the game stays paused.
    openIngameMenu();
});

// Losing window focus (alt-tab, OS overlay) can swallow keyup/mouseup
// events - release everything so no input stays stuck down.
window.addEventListener('blur', () => resetInput());
document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetInput();
});

// Mesh building runs on the main thread now (the integrated server worker
// owns generation); a small per-frame budget keeps the loop smooth.
function packMeshArrays(vertices, indices) {
    const big = vertices.length / 10 > 65535;
    return {
        vertices: vertices instanceof Float32Array ? vertices : new Float32Array(vertices),
        indices: big ? new Uint32Array(indices) : new Uint16Array(indices),
        indexCount: indices.length,
        big
    };
}

function uploadMesh(cx, cz, mesh) {
    const opaque = packMeshArrays(mesh.vertices, mesh.indices);
    const water  = packMeshArrays(mesh.waterVertices, mesh.waterIndices);
    uploadWorkerMesh({
        cx, cz,
        ...opaque,
        waterVertices: water.vertices, waterIndices: water.indices,
        waterIndexCount: water.indexCount, waterBig: water.big
    });
}

const meshQueue = new Set();
function enqueueMesh(key) {
    const c = world.chunks.get(key);
    if (c && c.generated && c.dirty) meshQueue.add(key);
}

function processMeshQueue(budget = 2) {
    let built = 0;
    for (const key of meshQueue) {
        meshQueue.delete(key);
        const chunk = world.chunks.get(key);
        if (!chunk || !chunk.generated || !chunk.dirty) continue;
        uploadMesh(chunk.cx, chunk.cz, buildChunkMesh(world, chunk));
        chunk.dirty = false;
        built++;
        if (built >= budget) break;
    }
    if (built > 0) {
        meshedChunks += built;
        if (meshedChunks === built || meshedChunks % 50 < built) {
            console.log(`[client] meshes built: ${meshedChunks} ` +
                `(queue: ${meshQueue.size})`);
        }
    }
}

// Wire protocol opcodes (must match src/server/server.js)
const MSG_CHUNK_REQUEST   = 1;  // client -> server
const MSG_SET_BLOCK       = 2;  // client -> server
const MSG_PLAYER_STATE    = 3;  // client -> server
const MSG_CHUNK_DATA      = 10; // server -> client
const MSG_SET_BLOCK_APPLY = 11; // server -> client (validated edit)
const MSG_EDIT_REJECTED   = 12; // server -> client

let spawned = false;
let receivedChunks = 0;
let meshedChunks = 0;
const pendingRequests = new Set();
const earlyFrames = []; // chunk requests made before the link opened

const net = new IsomorphicWebSocket('ws://loopback');
let netOpen = false;

// Count every outgoing/incoming message for the debug overlay TX/RX rates
const rawNetSend = net.send.bind(net);
net.send = (data) => {
    netStats.tx++;
    return rawNetSend(data);
};

net.onopen = () => {
    netOpen = true;
    net.send(JSON.stringify({ type: 'hello' }));
    console.log(`[client] link open - flushing ${earlyFrames.length} queued chunk requests`);
    for (const f of earlyFrames.splice(0)) net.send(f);
};
net.onerror = () => console.error('Server link error');
net.onmessage = (e) => {
    netStats.rx++;
    if (typeof e.data === 'string') { handleLinkMessage(e.data); return; }
    handleServerFrame(e.data);
};

function handleLinkMessage(data) {
    let msg = null;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg && msg.type === 'manifest') {
        blocks.loadManifest(msg.manifest);
        tex = createTextureAtlas(gl, blocks.textureUrls);
    }
}

function requestChunk(cx, cz) {
    const key = `${cx},${cz}`;
    if (pendingRequests.has(key)) return;
    pendingRequests.add(key);
    const buf = new ArrayBuffer(5);
    const v = new DataView(buf);
    v.setUint8(0, MSG_CHUNK_REQUEST);
    v.setInt16(1, cx, true);
    v.setInt16(3, cz, true);
    if (!netOpen) { earlyFrames.push(buf); return; }
    net.send(buf);
}

function sendSetBlock(x, y, z, blockType) {
    if (!netOpen) return;
    net.send(buildSetBlockFrame(MSG_SET_BLOCK, x, y, z, blockType));
}

// Player position/look, throttled to ~10 Hz from the render loop
let playerStateTimer = 0;
function updatePlayerState(dt) {
    playerStateTimer += dt;
    if (playerStateTimer < 0.1 || !netOpen) return;
    playerStateTimer = 0;
    const buf = new ArrayBuffer(21);
    const v = new DataView(buf);
    v.setUint8(0, MSG_PLAYER_STATE);
    v.setFloat32(1,  player.pos[0], true);
    v.setFloat32(5,  player.pos[1], true);
    v.setFloat32(9,  player.pos[2], true);
    v.setFloat32(13, camera.yaw, true);
    v.setFloat32(17, camera.pitch, true);
    net.send(buf);
}

function buildSetBlockFrame(op, x, y, z, t) {
    const buf = new ArrayBuffer(14);
    const v = new DataView(buf);
    v.setUint8(0, op);
    v.setInt32(1, x, true);
    v.setInt32(5, y, true);
    v.setInt32(9, z, true);
    v.setInt8(13, t);
    return buf;
}

function ingestChunk(cx, cz, voxels) {
    const key = `${cx},${cz}`;
    let chunk = world.chunks.get(key);
    const isNew = !chunk;
    if (!chunk) {
        chunk = new Chunk(cx, cz);
        world.chunks.set(key, chunk);
    }
    for (let i = 0; i < voxels.length; i += 4) {
        chunk.voxels.set(voxels[i] + ',' + voxels[i + 1] + ',' + voxels[i + 2],
            voxels[i + 3]);
    }
    chunk.generated = true;
    chunk.dirty = true;
    enqueueMesh(key);
    receivedChunks++;
    if (receivedChunks === 1 || receivedChunks % 50 === 0) {
        console.log(`[client] chunk ${cx},${cz} received from server ` +
            `(total: ${receivedChunks}) - mesh builder queued`);
    }
    // A brand-new chunk changes border faces / AO of existing neighbours
    if (isNew) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                if (!dx && !dz) continue;
                const nk = `${cx + dx},${cz + dz}`;
                const n = world.chunks.get(nk);
                if (n && n.generated) { n.dirty = true; enqueueMesh(nk); }
            }
        }
    }
    pendingRequests.delete(key);
}

function applyRemoteBlock(x, y, z, t) {
    if (t < 0) world.delete(x, y, z);
    else world.set(x, y, z, t);

    // Re-mesh the edited chunk plus every chunk this change borders
    // (including the diagonal, since AO samples across chunk corners).
    const cx = World.toChunkCoord(x);
    const cz = World.toChunkCoord(z);
    const lx = World.toLocal(x);
    const lz = World.toLocal(z);
    const xs = [0];
    const zs = [0];
    if (lx === 0) xs.push(-1);
    if (lx === CHUNK_SIZE - 1) xs.push(1);
    if (lz === 0) zs.push(-1);
    if (lz === CHUNK_SIZE - 1) zs.push(1);
    for (const dx of xs) {
        for (const dz of zs) {
            const key = `${cx + dx},${cz + dz}`;
            const c = world.chunks.get(key);
            if (c && c.generated) { c.dirty = true; enqueueMesh(key); }
        }
    }
}

function handleServerFrame(buffer) {
    const view = new DataView(buffer);
    const type = view.getUint8(0);
    if (type === MSG_CHUNK_DATA) {
        const cx = view.getInt16(1, true);
        const cz = view.getInt16(3, true);
        const count = view.getInt32(5, true);
        ingestChunk(cx, cz, new Int8Array(buffer, 9, count * 4));
        if (!spawned && cx === 0 && cz === 0) {
            placeOnTerrain(player, world, 0, 0);
            spawned = true;
        }
    } else if (type === MSG_SET_BLOCK_APPLY) {
        const x = view.getInt32(1, true);
        const y = view.getInt32(5, true);
        const z = view.getInt32(9, true);
        applyRemoteBlock(x, y, z, view.getInt8(13));
    } else if (type === MSG_EDIT_REJECTED) {
        const x = view.getInt32(1, true);
        const y = view.getInt32(5, true);
        const z = view.getInt32(9, true);
        console.log(`[client] server rejected edit at ${x},${y},${z}`);
    }
}

// Spawn player once terrain exists; request spawn chunk + initial area
requestChunk(0, 0);
const INITIAL_CHUNKS = [];
for (let dx = -renderDistance; dx <= renderDistance; dx++) {
    for (let dz = -renderDistance; dz <= renderDistance; dz++) {
        if (dx * dx + dz * dz <= renderDistance * renderDistance) {
            INITIAL_CHUNKS.push([dx, dz]);
        }
    }
}
INITIAL_CHUNKS.forEach(([dx, dz]) => requestChunk(dx, dz));

//  Glow cube (static) 
const glowCube = buildUnitCubeMesh();
const glowVBO = gl.createBuffer();
const glowIBO = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, glowVBO);
gl.bufferData(gl.ARRAY_BUFFER, glowCube.vertices, gl.STATIC_DRAW);
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glowIBO);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, glowCube.indices, gl.STATIC_DRAW);

//  Particles 
const particles = createParticleSystem(600);
const particleVBO = gl.createBuffer();
const particleIBO = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, particleVBO);
gl.bufferData(gl.ARRAY_BUFFER, 600 * 4 * 9 * 4, gl.DYNAMIC_DRAW); // 600 particles * 4 verts * 9 floats * 4 bytes
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, particleIBO);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, particles.indices.byteLength, gl.DYNAMIC_DRAW);

const REACH = 16;

// Vertical extent of every chunk's world AABB for frustum culling -
// spans full generation range (grid -1..31 = world -3..63) plus margin.
const CHUNK_MIN_Y = -4;
const CHUNK_MAX_Y = 64;

//  Break / Place (chunk-aware) 
function tryBreak() {
    const eye = playerEyePos(player);
    const forward = cameraForward(camera);
    const hit = voxelRaycast(world, eye, forward, REACH);
    if (!hit) return;
    const cx = World.toChunkCoord(hit.x);
    const cz = World.toChunkCoord(hit.z);
    const chunk = world.getChunk(cx, cz);
    const blockType = chunk ? chunk.get(World.toLocal(hit.x), hit.y, World.toLocal(hit.z)) : 0;
    
    // Map block types to particle texture layers via the block registry
    spawnBreakParticles(particles, hit.x, hit.y, hit.z, blocks.particleLayer(blockType));
    // Server-authoritative: intent only
    sendSetBlock(hit.x, hit.y, hit.z, -1);
}

function tryPlace() {
    const eye = playerEyePos(player);
    const forward = cameraForward(camera);
    const hit = voxelRaycast(world, eye, forward, REACH);
    if (!hit) return;
    const px = hit.x + hit.face[0];
    const py = hit.y + hit.face[1];
    const pz = hit.z + hit.face[2];
    if (blockOverlapsPlayer(player, px, py, pz)) return;
    // Server-authoritative: intent only
    sendSetBlock(px, py, pz, blocks.defaultId);
}

//  Break / Place hold-to-repeat 
// First click fires instantly; keeping the button down repeats the action
// after a short delay so a stray long press can't chew through blocks.
const HOLD_REPEAT_DELAY = 0.3;  // s before repeats begin
const HOLD_REPEAT_RATE  = 0.25; // s between repeats

const mouseHeld = { break: false, place: false };
let holdCooldown = 0;

canvas.addEventListener('mousedown', (e) => {
    if (!camera.locked) return;
    if (e.button === 0) {
        tryBreak();
        mouseHeld.break = true;
        mouseHeld.place = false;
        holdCooldown = HOLD_REPEAT_DELAY;
    } else if (e.button === 2) {
        tryPlace();
        mouseHeld.place = true;
        mouseHeld.break = false;
        holdCooldown = HOLD_REPEAT_DELAY;
    }
});
window.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouseHeld.break = false;
    else if (e.button === 2) mouseHeld.place = false;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// Release every held input (keys + mouse buttons). Used whenever the game
// loses input focus (menu open, window blur) so nothing stays latched.
function resetInput() {
    clearKeys(player);
    mouseHeld.break = false;
    mouseHeld.place = false;
    holdCooldown = 0;
}

// Called each frame from the render loop.
function updateHoldActions(dt) {
    const active = camera.locked && !screen && (mouseHeld.break || mouseHeld.place);
    if (!active) {
        holdCooldown = 0;
        return;
    }
    holdCooldown -= dt;
    if (holdCooldown > 0) return;
    if (mouseHeld.break) tryBreak();
    else if (mouseHeld.place) tryPlace();
    holdCooldown = HOLD_REPEAT_RATE;
}

// Clicking the canvas grabs the mouse - but never while a modal screen
// owns input, otherwise the menu could be bypassed by a stray click.
canvas.addEventListener('click', () => requestGameLock());

function resize() {
    // Render at native device resolution: upscaling a CSS-pixel buffer on
    // HiDPI screens smears distant block edges into faint crawling lines.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
    }
}

const FSIZE = Float32Array.BYTES_PER_ELEMENT;
const PF    = Float32Array.BYTES_PER_ELEMENT;

//  Chunk load/unload logic 
let lastPlayerChunkX = null;
let lastPlayerChunkZ = null;

// Movement is only allowed once the player's chunk and all 8 neighbours
// have generated voxel data (prevents falling through unloaded terrain).
function playerChunksReady() {
    const pgx = Math.floor(player.pos[0] / 2);
    const pgz = Math.floor(player.pos[2] / 2);
    const pcx = Math.floor(pgx / CHUNK_SIZE);
    const pcz = Math.floor(pgz / CHUNK_SIZE);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            if (!world.isChunkLoaded(pcx + dx, pcz + dz)) return false;
        }
    }
    return true;
}

function updateChunkLoading() {
    // Player world-space pos → grid pos → chunk pos
    const pgx = Math.floor(player.pos[0] / 2);
    const pgz = Math.floor(player.pos[2] / 2);
    const pcx = Math.floor(pgx / CHUNK_SIZE);
    const pcz = Math.floor(pgz / CHUNK_SIZE);

    if (pcx === lastPlayerChunkX && pcz === lastPlayerChunkZ) return;
    lastPlayerChunkX = pcx;
    lastPlayerChunkZ = pcz;

    // Determine needed chunk keys
    const needed = new Set();
    for (let dx = -renderDistance; dx <= renderDistance; dx++) {
        for (let dz = -renderDistance; dz <= renderDistance; dz++) {
            if (dx * dx + dz * dz > renderDistance * renderDistance) continue;
            const cx = pcx + dx;
            const cz = pcz + dz;
            const key = `${cx},${cz}`;
            needed.add(key);
            if (!world.isChunkLoaded(cx, cz)) {
                requestChunk(cx, cz);
            }
        }
    }

    // Unload chunks outside range (collect keys first to avoid iterator issues)
    const toUnload = [];
    for (const [key] of world.chunks) {
        if (!needed.has(key)) toUnload.push(key);
    }
    for (const key of toUnload) {
        const comma = key.indexOf(',');
        deleteChunkGPU(key);
        const ucx = parseInt(key.substring(0, comma));
        const ucz = parseInt(key.substring(comma + 1));
        world.unloadChunk(ucx, ucz);
        // Server keeps generated chunks cached; no unload message needed
    }
}

// +/- adjust view distance (clamped, saved across sessions)
window.addEventListener('keydown', (e) => {
    let delta = 0;
    if (e.code === 'Equal' || e.code === 'NumpadAdd') delta = 1;
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract') delta = -1;
    else return;

    setRenderDistance(renderDistance + delta);
});

//  Render loop 
let lastTime = 0;
function render(now) {
    if (lastTime === 0) lastTime = now;
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;

    resize();

    // Nothing meaningful can render before the mod manifest arrives
    // (no atlas, no block definitions); skip the frame entirely.
    if (!blocks.ready || !tex) {
        requestAnimationFrame(render);
        return;
    }

    updateChunkLoading();
    processMeshQueue();
    updatePlayerState(dt);
    // Modal screens (pause menu, settings) freeze player simulation -
    // keys were cleared on open, and held inputs must not accumulate.
    if (!screen && playerChunksReady()) updatePlayer(player, camera, world, dt);
    updateParticles(particles, dt);
    updateHoldActions(dt);

    // Sky / fog clear color
    gl.clearColor(FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2], 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = canvas.width / canvas.height;
    const fov = updateCameraFov(camera, player.sprinting, dt);
    const projectionMat = Mat4.perspective(fov, aspect, 0.1, RENDER_DISTANCE_UNITS + 40.0);

    const eye = playerEyePos(player);
    const forward = cameraForward(camera);
    const lookX = eye[0] + forward[0];
    const lookY = eye[1] + forward[1];
    const lookZ = eye[2] + forward[2];
    const viewMat = Mat4.lookAt(eye, [lookX, lookY, lookZ], [0, 1, 0]);

    //  Frustum culling: skip chunks outside the view (behind the player,
    //  above/below or beside the screen). Chunk world AABBs are derived
    //  from the chunk key; Y is a fixed range spanning all generation.
    const frustum = frustumPlanes(Mat4.multiply(projectionMat, viewMat));
    const visibleChunks = [];
    for (const [key, gpu] of chunkGPU) {
        if (gpu.indexCount === 0 && !gpu.waterIndexCount) continue;
        const comma = key.indexOf(',');
        const ccx = parseInt(key.substring(0, comma));
        const ccz = parseInt(key.substring(comma + 1));
        const baseX = ccx * CHUNK_SIZE * 2;
        const baseZ = ccz * CHUNK_SIZE * 2;
        if (!aabbIntersectsFrustum(frustum,
                baseX - 1, CHUNK_MIN_Y, baseZ - 1,
                baseX + CHUNK_SIZE * 2 - 1, CHUNK_MAX_Y,
                baseZ + CHUNK_SIZE * 2 - 1)) continue;
        visibleChunks.push(gpu);
    }

    //  Voxels (per-chunk) 
    gl.useProgram(voxelProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(tex.target, tex.texture);
    gl.uniform1i(voxelUniforms.texture, 0);
    gl.uniformMatrix4fv(voxelUniforms.projection, false, projectionMat);
    gl.uniformMatrix4fv(voxelUniforms.view,       false, viewMat);
    gl.uniformMatrix4fv(voxelUniforms.model,      false, Mat4.identity());
    gl.uniform3f(voxelUniforms.fogColor, FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2]);
    gl.uniform1f(voxelUniforms.fogNear, FOG_NEAR);
    gl.uniform1f(voxelUniforms.fogFar,  FOG_FAR);

    const bindVoxelAttribs = () => {
        gl.vertexAttribPointer(voxelAttribs.position, 3, gl.FLOAT, false, FSIZE * 10, 0);
        gl.enableVertexAttribArray(voxelAttribs.position);
        gl.vertexAttribPointer(voxelAttribs.texCoord, 2, gl.FLOAT, false, FSIZE * 10, FSIZE * 3);
        gl.enableVertexAttribArray(voxelAttribs.texCoord);
        gl.vertexAttribPointer(voxelAttribs.normal,   3, gl.FLOAT, false, FSIZE * 10, FSIZE * 5);
        gl.enableVertexAttribArray(voxelAttribs.normal);
        gl.vertexAttribPointer(voxelAttribs.ao,       1, gl.FLOAT, false, FSIZE * 10, FSIZE * 8);
        gl.enableVertexAttribArray(voxelAttribs.ao);
        if (voxelAttribs.layer >= 0) {
            gl.vertexAttribPointer(voxelAttribs.layer, 1, gl.FLOAT, false, FSIZE * 10, FSIZE * 9);
            gl.enableVertexAttribArray(voxelAttribs.layer);
        }
    };

    for (const gpu of visibleChunks) {
        if (gpu.indexCount === 0) continue;
        gl.bindBuffer(gl.ARRAY_BUFFER, gpu.vbo);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.ibo);
        bindVoxelAttribs();
        gl.drawElements(gl.TRIANGLES, gpu.indexCount, gpu.indexGL, 0);
    }

    //  Water (blended pass over the opaque geometry).
    //  Depth writes stay off so translucent surfaces never occlude
    //  geometry drawn afterwards (selection glow, particles) - otherwise
    //  the selection box vanishes behind any water surface in front of it.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    for (const gpu of visibleChunks) {
        if (!gpu.waterIndexCount) continue;
        gl.bindBuffer(gl.ARRAY_BUFFER, gpu.wvbo);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gpu.wibo);
        bindVoxelAttribs();
        gl.drawElements(gl.TRIANGLES, gpu.waterIndexCount, gpu.waterIndexGL, 0);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    //  Glow on targeted block 
    const hit = voxelRaycast(world, eye, forward, REACH);
    if (hit) {
        gl.useProgram(glowProgram);
        gl.uniformMatrix4fv(glowUniforms.projection, false, projectionMat);
        gl.uniformMatrix4fv(glowUniforms.view,       false, viewMat);
        gl.uniformMatrix4fv(
            glowUniforms.model, false,
            Mat4.translationScale(hit.x * 2.0, hit.y * 2.0, hit.z * 2.0, 1.001)
        );
        gl.uniform4f(glowUniforms.color, 1.0, 1.0, 1.0, 0.45);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);

        // The 1.001 inflation is smaller than depth-buffer resolution at
        // range, so bias the overlay toward the camera in depth instead -
        // this wins the fight at any distance without visible geometry gaps.
        gl.enable(gl.POLYGON_OFFSET_FILL);
        gl.polygonOffset(-1.0, -2.0);

        gl.bindBuffer(gl.ARRAY_BUFFER, glowVBO);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, glowIBO);
        gl.vertexAttribPointer(glowAttribs.position, 3, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(glowAttribs.position);
        gl.drawElements(gl.TRIANGLES, glowCube.indexCount, gl.UNSIGNED_SHORT, 0);

        gl.polygonOffset(0.0, 0.0);
        gl.disable(gl.POLYGON_OFFSET_FILL);

        gl.depthMask(true);
        gl.disable(gl.BLEND);
    }

    //  Particles (textured billboard quads) 
    const pCount = buildParticleBuffer(particles);
    if (pCount > 0) {
        gl.useProgram(particleProgram);
        gl.uniformMatrix4fv(particleUniforms.projection, false, projectionMat);
        gl.uniformMatrix4fv(particleUniforms.view,       false, viewMat);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(tex.target, tex.texture);
        gl.uniform1i(particleUniforms.texture, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, particleVBO);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0,
            particles.buffer.subarray(0, pCount * 36));
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, particleIBO);
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0,
            particles.indices.subarray(0, pCount * 6));

        gl.vertexAttribPointer(particleAttribs.centerPos, 3, gl.FLOAT, false, PF * 9, 0);
        gl.enableVertexAttribArray(particleAttribs.centerPos);
        gl.vertexAttribPointer(particleAttribs.offset,   2, gl.FLOAT, false, PF * 9, PF * 3);
        gl.enableVertexAttribArray(particleAttribs.offset);
        gl.vertexAttribPointer(particleAttribs.texCoord, 2, gl.FLOAT, false, PF * 9, PF * 5);
        gl.enableVertexAttribArray(particleAttribs.texCoord);
        gl.vertexAttribPointer(particleAttribs.size,     1, gl.FLOAT, false, PF * 9, PF * 7);
        gl.enableVertexAttribArray(particleAttribs.size);
        gl.vertexAttribPointer(particleAttribs.blockType, 1, gl.FLOAT, false, PF * 9, PF * 8);
        gl.enableVertexAttribArray(particleAttribs.blockType);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
        gl.disable(gl.CULL_FACE);
        gl.drawElements(gl.TRIANGLES, pCount * 6, gl.UNSIGNED_SHORT, 0);
        gl.enable(gl.CULL_FACE);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
    }

    requestAnimationFrame(render);
}
requestAnimationFrame(render);
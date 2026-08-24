// Integrated game server. Spawned inside a dedicated worker by
// gamestart.js; speaks the LoopbackServer relay protocol so clients
// connect with a plain IsomorphicWebSocket('ws://loopback'):
//
//   main   -> worker : {type: socket-connect|socket-message|socket-close, socketId}
//   worker -> main   : {type: socket-open|socket-message|socket-close, socketId}
//
// Wire format (binary frames, little endian):
//   client -> server   1: chunk-request  [i16 cx][i16 cz]
//                      2: edit intent    [i32 x][i32 y][i32 z][i8 type, -1 = break]
//                      3: player-state   [f32 px][f32 py][f32 pz][f32 yaw][f32 pitch]
//
// Control channel (JSON text): on {type:'hello'} the server replies with
// {type:'manifest', manifest} describing every modded block for rendering.
import { ServerWorld } from './world.js';
import { blockRegistry } from './BlockRegistryServer.js';

const MSG_CHUNK_REQUEST = 1;
const MSG_SET_BLOCK = 2;
const MSG_PLAYER_STATE = 3;
const MSG_CHUNK_DATA = 10;
const MSG_SET_BLOCK_APPLY = 11;
const MSG_EDIT_REJECTED = 12;

function startIntegratedServer() {
    // Mods must finish loading (registry populated) before terrain
    // generation runs, so incoming relay traffic is buffered until then.
    let handleEvent = (msg) => void queued.push(msg);
    const queued = [];
    const sockets = new Map();
    const players = new Map(); // socketId -> {x,y,z,yaw,pitch}
    let chunksServed = 0;
    let world = null;

    console.log('[integrated-server] starting, seed 42');
    self.onmessage = (e) => handleEvent(e.data);

    init();

    async function init() {
        await blockRegistry.loadMods();
        world = new ServerWorld(42);

        handleEvent = onEvent;
        for (const msg of queued.splice(0)) onEvent(msg);
        self.postMessage({ type: 'server-ready' });
    }

    function onEvent(msg) {
        if (msg.type === 'socket-connect') {
            console.log(`[integrated-server] client connected (${msg.socketId})`);
            const socketId = msg.socketId;
            const sock = {
                id: socketId,
                onmessage: null,
                readyState: 1,
                send(data) { forwardToMain(socketId, data); },
                close() { self.postMessage({ type: 'socket-close', socketId }); }
            };
            sockets.set(socketId, sock);
            self.postMessage({ type: 'socket-open', socketId });
            serveClient(sock);
        } else if (msg.type === 'socket-message') {
            const sock = sockets.get(msg.socketId);
            if (sock && sock.onmessage) sock.onmessage({ data: msg.data });
        } else if (msg.type === 'socket-close') {
            sockets.delete(msg.socketId);
        }
    }

    function forwardToMain(socketId, data) {
        if (typeof data === 'string') {
            self.postMessage({ type: 'socket-message', socketId, data });
        } else {
            const ab = data instanceof ArrayBuffer ? data
                : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            self.postMessage({ type: 'socket-message', socketId, data: ab });
        }
    }

    function serveClient(sock) {
        sock.onmessage = (event) => {
            const data = event.data;
            if (typeof data === 'string') {
                let msg = null;
                try { msg = JSON.parse(data); } catch { return; }
                if (msg && msg.type === 'hello') {
                    // Manifest first so the client can build its atlas and
                    // resolve block ids before any chunk data arrives.
                    sock.send(JSON.stringify({
                        type: 'manifest',
                        manifest: blockRegistry.manifest
                    }));
                }
                return;
            }
            const view = new DataView(data);
            const type = view.getUint8(0);
            if (type === MSG_CHUNK_REQUEST) {
                const cx = view.getInt16(1, true);
                const cz = view.getInt16(3, true);
                sendChunk(sock, cx, cz);
            } else if (type === MSG_PLAYER_STATE) {
                const prev = players.get(sock.id);
                const p = {
                    x: view.getFloat32(1, true),
                    y: view.getFloat32(5, true),
                    z: view.getFloat32(9, true),
                    yaw: view.getFloat32(13, true),
                    pitch: view.getFloat32(17, true)
                };
                players.set(sock.id, p);
                // Log the first update and every ~10 s worth (at 10 Hz)
                if (!prev || (p.x !== prev.x && chunksServed % 100 === 0)) {
                    console.log(`[integrated-server] player @ ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`);
                }
            } else if (type === MSG_SET_BLOCK) {
                const x = view.getInt32(1, true);
                const y = view.getInt32(5, true);
                const z = view.getInt32(9, true);
                const t = view.getInt8(13);
                if (world.validateEdit(x, y, z, t)) {
                    // Authoritative confirmation - clients apply on receipt
                    sock.send(buildSetBlockFrame(MSG_SET_BLOCK_APPLY, x, y, z, t));
                } else {
                    sock.send(buildSetBlockFrame(MSG_EDIT_REJECTED, x, y, z, t));
                    console.log(`[integrated-server] rejected edit at ${x},${y},${z} (type ${t})`);
                }
            }
        };
    }

    function sendChunk(sock, cx, cz) {
        const voxels = world.getChunkPacked(cx, cz);
        const buf = new ArrayBuffer(9 + voxels.length);
        const view = new DataView(buf);
        view.setUint8(0, MSG_CHUNK_DATA);
        view.setInt16(1, cx, true);
        view.setInt16(3, cz, true);
        view.setInt32(5, voxels.length / 4, true);
        new Int8Array(buf, 9).set(voxels);
        sock.send(buf);
        if (++chunksServed === 1 || chunksServed % 50 === 0) {
            console.log(`[integrated-server] sent chunk ${cx},${cz} ` +
                `(${voxels.length / 4} blocks) - total: ${chunksServed}`);
        }
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

    self.postMessage({ type: 'server-ready' });
}

// Module workers have no document; only auto-start in worker scope.
if (typeof document === 'undefined') {
    startIntegratedServer();
}

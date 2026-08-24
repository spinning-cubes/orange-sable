// Entry point: boot the integrated server in a dedicated worker (so
// worldgen never blocks rendering), wire it into the loopback relay, then
// load the game client, which connects via IsomorphicWebSocket('ws://loopback').
import { globalLoopbackServer } from '/src/shared/IsomorphicWebSocket.js';

// The blob worker needs a FULL absolute URL - relative paths do not
// resolve against blob: script URLs.
const serverEntry = location.origin + '/src/server/server.js';
const serverWorker = new Worker(
    URL.createObjectURL(
        new Blob([`import ${JSON.stringify(serverEntry)};`], { type: 'text/javascript' })
    ),
    { type: 'module' }
);
serverWorker.onerror = (err) => console.error('Integrated server error:', err.message || err);

globalLoopbackServer.attachWorker(serverWorker);

// Wait for the server to finish booting, and route ALL relay traffic
// (socket-open / socket-message / socket-close) into the loopback server.
await new Promise((resolve) => {
    const timer = setTimeout(() => {
        console.warn('[gamestart] server-ready timeout - continuing anyway');
        resolve();
    }, 3000);
    serverWorker.onmessage = (e) => {
        const msg = e.data;
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'server-ready') {
            console.log('[gamestart] integrated server ready');
            clearTimeout(timer);
            resolve();
            return;
        }
        globalLoopbackServer.handleWorkerMessage(msg);
    };
});

await import('/src/client/main.js');

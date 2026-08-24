import Screen from "./Screen.js";
import { netStats } from "../netstats.js";

const TICK_MS = 250;
const BLOCK_UNITS = 2; // one voxel = 2 world units

export default class DebugOverlay extends Screen {
    constructor(game, lastScreen, data = {}) {
        super(game, lastScreen);
        this.player = data.player || null;

        this.view.loadData(`
formspec_version[6]
size[8,4]
label[0.1,0.3;OrangeSable 1.0;dbg_version]
label[0.1,0.6;X: 0.0 Y: 0.0 Z: 0.0;dbg_coords]
label[0.1,0.9;TX: 0 / RX: 0;dbg_net]
        `);
        this.view.setOpacity(0.0);
        this.view.hudAnchor = 'top-left';

        this._timer = null;
        this._lastTx = 0;
        this._lastRx = 0;
        this._lastTime = 0;
        this._txRate = 0;
        this._rxRate = 0;
    }

    render() {
        this._stopTimer();
        super.render();
        this._sample();
        this.tick();
        this._timer = setInterval(() => this.tick(), TICK_MS);
    }

    exit() {
        this._stopTimer();
        super.exit();
    }

    _sample() {
        this._lastTx = netStats.tx;
        this._lastRx = netStats.rx;
        this._lastTime = performance.now();
        this._txRate = 0;
        this._rxRate = 0;
    }

    tick() {
        // Torn down by another showScreen() without exit() - stop ticking.
        if (!this.view.isRendered) {
            this._stopTimer();
            return;
        }

        // Messages-per-second over the elapsed window since the last tick.
        const now = performance.now();
        const dt = (now - this._lastTime) / 1000;
        if (dt > 0) {
            this._txRate = Math.round((netStats.tx - this._lastTx) / dt);
            this._rxRate = Math.round((netStats.rx - this._lastRx) / dt);
            this._lastTx = netStats.tx;
            this._lastRx = netStats.rx;
            this._lastTime = now;
        }

        const p = this.player;
        const coords = p
            ? `X: ${(p.pos[0] / BLOCK_UNITS).toFixed(1)} ` +
              `Y: ${(p.pos[1] / BLOCK_UNITS).toFixed(1)} ` +
              `Z: ${(p.pos[2] / BLOCK_UNITS).toFixed(1)}`
            : 'X: ? Y: ? Z: ?';

        this.view.setData('dbg_coords', coords);
        this.view.setData('dbg_net', `TX: ${this._txRate} / RX: ${this._rxRate}`);
    }

    _stopTimer() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }
}

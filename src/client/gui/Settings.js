import Screen from "./Screen.js";

// Settings dialog. Field defaults come from the current game state via the
// data argument; Save validates, hands values to data.onSave, and returns
// to the parent screen.
export default class SettingsScreen extends Screen {
    constructor(game, lastScreen, data = {}) {
        super(game, lastScreen);

        const rd  = Number.isFinite(Number(data.renderDistance)) ? Number(data.renderDistance) : 10;
        const fov = Number.isFinite(Number(data.fov)) ? Number(data.fov) : 70;

        this.view.loadData(`
formspec_version[6]
size[5.5,5.3]
label[2.1,0.4;Settings]
field[0.1,1.1;5.3,0.7;renderdist;Render Distance;${rd}]
field[0.1,2.4;5.3,0.7;fov;Field of View (FOV);${fov}]
button[0.1,4.4;5.3,0.8;save;Save Changes]
label[0.1,3.5;(NOT USED)]
checkbox[5,3.5;buser;;false]
label[0.1,4;(NOT USED)]
checkbox[5,4;inc;;false]
        `);

        this._onSave = typeof data.onSave === 'function' ? data.onSave : null;
        this.view.onButton('save', () => this.save());
    }

    save() {
        const settings = {
            renderDistance: parseInt(this.view.getData('renderdist'), 10),
            fov: parseFloat(this.view.getData('fov')),
            buser: this.view.getData('buser'),
            inc: this.view.getData('inc')
        };
        if (this._onSave) this._onSave(settings);
        console.log('[settings] saved', settings);
        this.exit();
    }
}

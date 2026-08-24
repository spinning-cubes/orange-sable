import Screen from "./Screen.js";

// Pause menu shown whenever pointer lock is lost during play. The host
// supplies onResume/onSettings through the data argument; "Quit to Title"
// stays inert until a title screen exists.
export default class IngameMenu extends Screen {
    constructor(game, lastScreen, actions = {}) {
        super(game, lastScreen);
        this.view.loadData(`
formspec_version[6]
size[7,4]
button[0.3,0.8;6.4,0.8;exit;Resume Game]
label[1.4,0.4;OrangeSable - Ingame Menu]
button[0.3,1.9;6.4,0.8;settings;Settings]
button[0.3,3;6.4,0.8;title;Quit to Title (NOT READY YET)]
        `);

        this.view.onButton('exit', () => {
            if (typeof actions.onResume === 'function') actions.onResume();
        });
        this.view.onButton('settings', () => {
            if (typeof actions.onSettings === 'function') actions.onSettings();
        });
    }
}

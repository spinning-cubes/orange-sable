import Screen from "./Screen.js";

export default class BrowserScreen extends Screen {
    constructor(game, lastScreen) {
        super(game, lastScreen);
        this.view.loadData(`
formspec_version[6]
size[16,10]
image[0.2,0.6;15.6,9.2;test]
button[15.4,0.1;0.4,0.4;exit;X]
field[0.2,0.1;13.1,0.4;stuff;;https://breakmine.com]
button[14.9,0.1;0.4,0.4;forward;>]
button[14.4,0.1;0.4,0.4;back;<]
button[13.4,0.1;0.9,0.4;go;GO]
        `);

        this.view.onButton('exit', () => this.exit());
    }
}

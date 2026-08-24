import Formspec from "./Formspec.js";

export default class Screen {
    constructor(game, lastScreen) {
        this.game = game;
        this.lastScreen = lastScreen;
        this.view = new Formspec();
        this.view.setAssetPath('/src/assets/');
    }

    render() {
        this.view.delete();
        this.view.render();
    }

    exit() {
        this.view.delete();
        if (this.lastScreen) {
            this.lastScreen.render();
        }
        // Let the host re-point its active screen at whatever is visible now
        if (this.game && typeof this.game.onScreenExit === 'function') {
            this.game.onScreenExit(this);
        }
    }
}
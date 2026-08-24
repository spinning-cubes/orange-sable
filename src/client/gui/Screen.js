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
            // Restore the game's active screen reference to the parent screen
            this.game.screen = this.lastScreen;
            this.lastScreen.render();
        }
    }
}
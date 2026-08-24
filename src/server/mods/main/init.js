main.setModNamespace = "sable";

main.registerBlock({
    name: "grass",
    description: "Grass",
    texture: function(face, x, y, z, world) {
        if (face === "top") {
            return "grass_top";
        } else if (face === "bottom") {
            return "dirt";
        } else {
            return "grass";
        }
    }
});

main.registerBlock({
    name: "log",
    description: "Log",
    texture: function(face, x, y, z, world) {
        if (face === "top" || face === "bottom") {
            return "log_top";
        } else {
            return "log_side";
        }
    }
});

['dirt', 'leaf', 'planks', 'sand', 'stone'].forEach(function(block) {
    main.registerBlock({
        name: block,
        description: block.charAt(0).toUpperCase() + block.slice(1),
        texture: function(face, x, y, z, world) {
            return block;
        }
    });
});

main.registerBlock({
    name: "water",
    description: "Water",
    isFluid: true,
    isTransparent: true,
    texture: function(face, x, y, z, world) {
        return "water";
    }
})
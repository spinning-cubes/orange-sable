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
    name: "test",
    description: "Test Plant",
    renderType: "plant",
    isSolid: false,
    isTransparent: true,
    texture: function(face, x, y, z, world) {
        return "test";
    }
});

main.registerBlock({
    name: "water",
    description: "Water",
    isFluid: true,
    isTransparent: true,
    transparentType: "blend",
    texture: function(face, x, y, z, world) {
        return "water";
    }
});

main.registerBlock({
    name: "test_2",
    description: "Test2",
    renderType: "nodebox",
    actsTransparent: true,
    texture: function(face, x, y, z, world, part) {
        return 'test';
    },
    nodebox: [
        [
            'part1', 
            -0.25, -0.5, -0.25,
            0.25, 0.0, 0.25
        ]
    ]
});

main.include('worldgen.js');
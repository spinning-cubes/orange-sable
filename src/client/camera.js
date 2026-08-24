export function createCamera(canvas) {
    const cam = {
        yaw: 0.0,
        pitch: -0.1,
        locked: false,
        baseFov: Math.PI / 3,
        currentFov: Math.PI / 3
    };

    canvas.addEventListener('click', () => canvas.requestPointerLock());

    document.addEventListener('pointerlockchange', () => {
        cam.locked = (document.pointerLockElement === canvas);
    });

    document.addEventListener('mousemove', (e) => {
        if (!cam.locked) return;
        const sensitivity = 0.0025;
        cam.yaw   += e.movementX * sensitivity;
        cam.pitch -= e.movementY * sensitivity;
        const maxPitch = Math.PI / 2 - 0.05;
        cam.pitch = Math.max(-maxPitch, Math.min(maxPitch, cam.pitch));
    });

    return cam;
}

export function cameraForward(cam) {
    return [
        Math.cos(cam.pitch) * Math.sin(cam.yaw),
        Math.sin(cam.pitch),
       -Math.cos(cam.pitch) * Math.cos(cam.yaw)
    ];
}

export function updateCameraFov(cam, sprinting, dt) {
    const targetFov = sprinting ? cam.baseFov + 0.087 : cam.baseFov; // 5 degrees in radians
    cam.currentFov += (targetFov - cam.currentFov) * Math.min(1, dt * 10);
    return cam.currentFov;
}
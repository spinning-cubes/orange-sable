export function createPlayer() {
    const p = {
        pos: [0.0, 10.0, 0.0],  // will be set by placeOnTerrain()
        vel: [0, 0, 0],
        onGround: false,
        wasOnGround: false,
        crouching: false,
        sprinting: false,
        keys: {},
        currentEye: 3.5,
        eyeHeight: 3.5,
        crouchEye: 2.5,
        width: 0.6,
        height: 4.0,
        crouchHeight: 3.0,
        walkSpeed: 8.5,
        sprintSpeed: 12,
        crouchSpeed: 2.5,
        jumpSpeed: 12,
        gravity: 30
    };

    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space' || e.code === 'Tab' ||
            e.code === 'ControlLeft' || e.code === 'ControlRight' ||
            e.code === 'ShiftLeft'   || e.code === 'ShiftRight') e.preventDefault();
        p.keys[e.code] = true;
    });
    window.addEventListener('keyup', (e) => { p.keys[e.code] = false; });

    return p;
}

// Release every held key. Used when the game loses input focus (menu open,
// window blur) so keys can never get stuck in the down state.
export function clearKeys(p) {
    for (const k in p.keys) p.keys[k] = false;
}

// Place the player on top of the terrain at the given world-grid (x, z).
export function placeOnTerrain(player, world, gx, gz) {
    const sy = world.getSurfaceY(gx, gz);
    // World-space top of the surface block
    player.pos[0] = gx * 2;
    player.pos[1] = sy * 2 + 1;  // feet on top of block
    player.pos[2] = gz * 2;
    player.vel[1] = 0;
    player.onGround = true;
}

export function playerEyePos(p) {
    return [p.pos[0], p.pos[1] + p.currentEye, p.pos[2]];
}

function collidesAABB(world, pos, halfW, totalH) {
    const minX = Math.floor((pos[0] - halfW + 1) / 2);
    const maxX = Math.floor((pos[0] + halfW - 0.001 + 1) / 2);
    const minY = Math.floor((pos[1] + 1) / 2);
    const maxY = Math.floor((pos[1] + totalH - 0.001 + 1) / 2);
    const minZ = Math.floor((pos[2] - halfW + 1) / 2);
    const maxZ = Math.floor((pos[2] + halfW - 0.001 + 1) / 2);

    for (let gx = minX; gx <= maxX; gx++)
        for (let gy = minY; gy <= maxY; gy++)
            for (let gz = minZ; gz <= maxZ; gz++)
                if (world.isSolid(gx, gy, gz)) return true;
    return false;
}

// True when at least one solid block sits directly beneath the player's
// AABB footprint (probed a hair below the feet).
function hasSupportBelow(world, pos, halfW) {
    const minX = Math.floor((pos[0] - halfW + 1) / 2);
    const maxX = Math.floor((pos[0] + halfW - 0.001 + 1) / 2);
    const minZ = Math.floor((pos[2] - halfW + 1) / 2);
    const maxZ = Math.floor((pos[2] + halfW - 0.001 + 1) / 2);
    const gy = Math.floor((pos[1] - 0.1 + 1) / 2);
    for (let gx = minX; gx <= maxX; gx++)
        for (let gz = minZ; gz <= maxZ; gz++)
            if (world.isSolid(gx, gy, gz)) return true;
    return false;
}

function moveHorizontal(world, p, axis, dt, halfW, totalH) {
    const dist = p.vel[axis] * dt;
    if (dist === 0) return;
    const steps = Math.max(1, Math.ceil(Math.abs(dist) / 0.2));
    const step = dist / steps;

    // Sneak edge-guard: while crouching on the ground (and not jumping
    // upward), refuse any step that would leave the AABB without ground
    // beneath it - the classic "can't fall off while sneaking" clamp.
    const edgeGuard = p.crouching && p.wasOnGround && p.vel[1] <= 0;

    for (let i = 0; i < steps; i++) {
        const before = p.pos[axis];
        p.pos[axis] += step;
        if (collidesAABB(world, p.pos, halfW, totalH)) {
            if (p.vel[axis] > 0) {
                const face = p.pos[axis] + halfW;
                const g = Math.floor((face + 1) / 2);
                p.pos[axis] = g * 2 - 1 - halfW;
            } else {
                const face = p.pos[axis] - halfW;
                const g = Math.floor((face + 1) / 2);
                p.pos[axis] = g * 2 + 1 + halfW;
            }
            p.vel[axis] = 0;
            return;
        }
        if (edgeGuard && !hasSupportBelow(world, p.pos, halfW)) {
            // Undo the sub-step and kill the velocity so repeated frames
            // don't creep past the edge.
            p.pos[axis] = before;
            p.vel[axis] = 0;
            return;
        }
    }
}

function moveVertical(world, p, dt, halfW, totalH) {
    const dist = p.vel[1] * dt;
    if (dist === 0) return;
    const steps = Math.max(1, Math.ceil(Math.abs(dist) / 0.2));
    const step = dist / steps;

    for (let i = 0; i < steps; i++) {
        p.pos[1] += step;
        if (collidesAABB(world, p.pos, halfW, totalH)) {
            if (p.vel[1] < 0) {
                const gy = Math.floor((p.pos[1] + 1) / 2);
                p.pos[1] = gy * 2 + 1;
                p.onGround = true;
            } else {
                const headY = p.pos[1] + totalH;
                const gy = Math.floor((headY + 1) / 2);
                p.pos[1] = gy * 2 - 1 - totalH;
            }
            p.vel[1] = 0;
            return;
        }
    }
}

export function updatePlayer(p, cam, world, dt) {
    const halfW = p.width * 0.5;

    if (p.keys['ShiftLeft'] || p.keys['ShiftRight']) {
        p.crouching = true;
    } else if (p.crouching) {
        if (!collidesAABB(world, p.pos, halfW, p.height)) p.crouching = false;
    }
    p.sprinting = (p.keys['ControlLeft'] || p.keys['ControlRight']) && !p.crouching;

    const targetEye = p.crouching ? p.crouchEye : p.eyeHeight;
    p.currentEye += (targetEye - p.currentEye) * Math.min(1, dt * 12);

    const speed = p.crouching ? p.crouchSpeed
                : p.sprinting   ? p.sprintSpeed
                                : p.walkSpeed;
    const fx = Math.sin(cam.yaw);
    const fz = -Math.cos(cam.yaw);
    const rx = Math.cos(cam.yaw);
    const rz = Math.sin(cam.yaw);

    let mx = 0, mz = 0;
    if (p.keys['KeyW']) { mx += fx; mz += fz; }
    if (p.keys['KeyS']) { mx -= fx; mz -= fz; }
    if (p.keys['KeyD']) { mx += rx; mz += rz; }
    if (p.keys['KeyA']) { mx -= rx; mz -= rz; }
    const len = Math.hypot(mx, mz);
    if (len > 0) { mx = mx / len * speed; mz = mz / len * speed; }
    p.vel[0] = mx;
    p.vel[2] = mz;

    if (p.keys['Space'] && p.onGround && !p.crouching) {
        p.vel[1] = p.jumpSpeed;
        p.onGround = false;
    }

    p.vel[1] -= p.gravity * dt;
    if (p.vel[1] < -50) p.vel[1] = -50;

    const totalH = p.crouching ? p.crouchHeight : p.height;
    p.onGround = false;
    moveHorizontal(world, p, 0, dt, halfW, totalH);
    moveHorizontal(world, p, 2, dt, halfW, totalH);
    moveVertical(world, p, dt, halfW, totalH);
    // Grounded state seen by next frame's sneak edge-guard
    p.wasOnGround = p.onGround;
}

export function blockOverlapsPlayer(p, bx, by, bz) {
    const halfW = p.width * 0.5;
    const totalH = p.crouching ? p.crouchHeight : p.height;
    return (
        Math.abs(p.pos[0] - bx * 2) < 1 + halfW &&
        p.pos[1] < by * 2 + 1 &&
        p.pos[1] + totalH > by * 2 - 1 &&
        Math.abs(p.pos[2] - bz * 2) < 1 + halfW
    );
}
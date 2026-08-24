// Amanatides–Woo voxel traversal (DDA).
// Voxel (gx,gy,gz) has world center (gx*2, gy*2, gz*2) and half-extent 1,
// so in grid space (world / 2) each voxel spans [n-0.5, n+0.5]. Standard
// floor()-DDA assumes cells span [n, n+1], so we shift the origin by +0.5
// in grid space to align cell boundaries with the voxel storage convention.
// `direction` must be a unit vector in world space. Returns {x,y,z,face,t}
// or null. `face` is the entered-face normal (points back toward the ray
// origin), so placement goes at (hit + face).
export function voxelRaycast(world, origin, direction, maxDist = 8) {
    const ox = origin[0] * 0.5 + 0.5;
    const oy = origin[1] * 0.5 + 0.5;
    const oz = origin[2] * 0.5 + 0.5;
    const dx = direction[0];
    const dy = direction[1];
    const dz = direction[2];

    let gx = Math.floor(ox);
    let gy = Math.floor(oy);
    let gz = Math.floor(oz);

    const stepX = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
    const stepY = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
    const stepZ = dz > 0 ? 1 : (dz < 0 ? -1 : 0);

    const tDeltaX = stepX !== 0 ? Math.abs(1 / dx) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dy) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dz) : Infinity;

    let tMaxX = stepX > 0 ? (gx + 1 - ox) * tDeltaX
              : stepX < 0 ? (ox - gx)     * tDeltaX
              : Infinity;
    let tMaxY = stepY > 0 ? (gy + 1 - oy) * tDeltaY
              : stepY < 0 ? (oy - gy)     * tDeltaY
              : Infinity;
    let tMaxZ = stepZ > 0 ? (gz + 1 - oz) * tDeltaZ
              : stepZ < 0 ? (oz - gz)     * tDeltaZ
              : Infinity;

    const maxT = maxDist * 0.5; // grid-space t (1 grid unit = 2 world units)
    let t = 0;
    let face = [0, 0, 0];

    if (world.isSelectable(gx, gy, gz)) {
        return { x: gx, y: gy, z: gz, face: [0, 0, 0], t: 0 };
    }

    while (t <= maxT) {
        if (tMaxX < tMaxY && tMaxX < tMaxZ) {
            gx += stepX; t = tMaxX; tMaxX += tDeltaX;
            face = [-stepX, 0, 0];
        } else if (tMaxY < tMaxZ) {
            gy += stepY; t = tMaxY; tMaxY += tDeltaY;
            face = [0, -stepY, 0];
        } else {
            gz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
            face = [0, 0, -stepZ];
        }

        if (world.isSelectable(gx, gy, gz)) {
            return { x: gx, y: gy, z: gz, face, t };
        }
        if (t > maxT) break;
    }
    return null;
}
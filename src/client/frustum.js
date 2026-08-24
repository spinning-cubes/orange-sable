// View-frustum plane extraction (Gribb-Hartmann) and AABB overlap tests,
// used for chunk-level draw culling. Matrices are column-major
// Float32Array(16) matching mat4.js.

// Extract the 6 clip-space planes as [a, b, c, d] with outward normals.
// A world point is inside when a*x + b*y + c*z + d >= 0 for every plane.
export function frustumPlanes(clip) {
    // Row i of the row-major form of the column-major matrix
    const row = (i) => [clip[i], clip[i + 4], clip[i + 8], clip[i + 12]];
    const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);

    const planes = [];
    const push = (a, sign, b) => {
        const pa = a[0] + sign * b[0];
        const pb = a[1] + sign * b[1];
        const pc = a[2] + sign * b[2];
        const pd = a[3] + sign * b[3];
        const len = Math.hypot(pa, pb, pc) || 1;
        planes.push([pa / len, pb / len, pc / len, pd / len]);
    };

    push(r3,  1, r0); // left
    push(r3, -1, r0); // right
    push(r3,  1, r1); // bottom
    push(r3, -1, r1); // top
    push(r3,  1, r2); // near
    push(r3, -1, r2); // far
    return planes;
}

// True when the AABB is at least partially inside the frustum. Uses the
// "positive vertex" test: if the corner most aligned with each plane's
// normal is already outside that plane, the whole box is outside.
export function aabbIntersectsFrustum(planes, minX, minY, minZ, maxX, maxY, maxZ) {
    for (let i = 0; i < planes.length; i++) {
        const p = planes[i];
        const x = p[0] > 0 ? maxX : minX;
        const y = p[1] > 0 ? maxY : minY;
        const z = p[2] > 0 ? maxZ : minZ;
        if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
    }
    return true;
}

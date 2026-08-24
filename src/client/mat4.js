export const Mat4 = {
    identity() {
        return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    },
    translation(x, y, z) {
        return new Float32Array([
            1,0,0,0,
            0,1,0,0,
            0,0,1,0,
            x,y,z,1
        ]);
    },
    // Combined translation + uniform scale. Used for the glow cube.
    translationScale(tx, ty, tz, s) {
        return new Float32Array([
            s, 0, 0, 0,
            0, s, 0, 0,
            0, 0, s, 0,
            tx, ty, tz, 1
        ]);
    },
    perspective(fovy, aspect, near, far) {
        const f = 1.0 / Math.tan(fovy / 2);
        const nf = 1 / (near - far);
        return new Float32Array([
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (far + near) * nf, -1,
            0, 0, (2 * far * near) * nf, 0
        ]);
    },
    lookAt(eye, center, up) {
        let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
        let len = 1 / Math.hypot(z0, z1, z2);
        z0 *= len; z1 *= len; z2 *= len;

        let x0 = up[1] * z2 - up[2] * z1, x1 = up[2] * z0 - up[0] * z2, x2 = up[0] * z1 - up[1] * z0;
        len = 1 / Math.hypot(x0, x1, x2);
        x0 *= len; x1 *= len; x2 *= len;

        let y0 = z1 * x2 - z2 * x1, y1 = z2 * x0 - z0 * x2, y2 = z0 * x1 - z1 * x0;

        return new Float32Array([
            x0, y0, z0, 0,
            x1, y1, z1, 0,
            x2, y2, z2, 0,
            -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]),
            -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]),
            -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]),
            1
        ]);
    }
};
export const VOXEL_VS = `
    attribute vec3 aPosition;
    attribute vec2 aTexCoord;
    attribute vec3 aNormal;
    attribute float aAO;
    attribute float aTexLayer;
    uniform mat4 uModel;
    uniform mat4 uView;
    uniform mat4 uProjection;
    varying vec2 vTexCoord;
    varying float vTexLayer;
    varying vec3 vNormal;
    varying float vAO;
    varying float vFogDist;
    void main() {
        vTexCoord = aTexCoord;
        vTexLayer = aTexLayer;
        vNormal = mat3(uModel) * aNormal;
        vAO = aAO;
        vec4 worldPos = uModel * vec4(aPosition, 1.0);
        vec4 viewPos = uView * worldPos;
        vFogDist = length(viewPos.xyz);
        gl_Position = uProjection * viewPos;
    }
`;

export const VOXEL_FS = `
    precision mediump float;
    varying vec2 vTexCoord;
    varying float vTexLayer;
    varying vec3 vNormal;
    varying float vAO;
    varying float vFogDist;
    uniform sampler2D uTexture;
    uniform vec3 uFogColor;
    uniform float uFogNear;
    uniform float uFogFar;
    uniform float uAlphaTest;
    void main() {
        // WebGL1 fallback: reconstruct atlas UV from tile-local coords + layer
        vec2 uv = vec2((vTexLayer + vTexCoord.x) / 8.0, vTexCoord.y);
        vec4 texColor = texture2D(uTexture, uv);
        if (uAlphaTest > 0.0 && texColor.a < uAlphaTest) discard;
        vec3 norm = normalize(vNormal);
        vec3 anorm = abs(norm);
        float shade;
        if (anorm.y > anorm.x && anorm.y > anorm.z) {
            shade = norm.y > 0.0 ? 0.88 : 0.42;
        } else if (anorm.x > anorm.z) {
            shade = norm.x > 0.0 ? 0.62 : 0.50;
        } else {
            shade = norm.z > 0.0 ? 0.72 : 0.56;
        }
        vec3 color = texColor.rgb * shade * vAO;
        // Distance fog
        float fogFactor = clamp((uFogFar - vFogDist) / (uFogFar - uFogNear), 0.0, 1.0);
        color = mix(uFogColor, color, fogFactor);
        gl_FragColor = vec4(color, texColor.a);
    }
`;

export const VOXEL_VS_ARRAY = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec2 aTexCoord;
in vec3 aNormal;
in float aAO;
in float aTexLayer;
uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProjection;
out vec2 vTexCoord;
out float vTexLayer;
out vec3 vNormal;
out float vAO;
out float vFogDist;
void main() {
    vTexCoord = aTexCoord;
    vTexLayer = aTexLayer;
    vNormal = mat3(uModel) * aNormal;
    vAO = aAO;
    vec4 worldPos = uModel * vec4(aPosition, 1.0);
    vec4 viewPos = uView * worldPos;
    vFogDist = length(viewPos.xyz);
    gl_Position = uProjection * viewPos;
}
`;

export const VOXEL_FS_ARRAY = `#version 300 es
precision highp float;
in vec2 vTexCoord;
in float vTexLayer;
in vec3 vNormal;
in float vAO;
in float vFogDist;
uniform highp sampler2DArray uTexture;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uAlphaTest;
out vec4 fragColor;
void main() {
    // Each tile lives on its own array layer - no atlas bleed possible
    vec4 texColor = texture(uTexture, vec3(vTexCoord, vTexLayer));
    if (uAlphaTest > 0.0 && texColor.a < uAlphaTest) discard;
    vec3 norm = normalize(vNormal);
    vec3 anorm = abs(norm);
    float shade;
    if (anorm.y > anorm.x && anorm.y > anorm.z) {
        shade = norm.y > 0.0 ? 0.88 : 0.42;
    } else if (anorm.x > anorm.z) {
        shade = norm.x > 0.0 ? 0.62 : 0.50;
    } else {
        shade = norm.z > 0.0 ? 0.72 : 0.56;
    }
    vec3 color = texColor.rgb * shade * vAO;
    float fogFactor = clamp((uFogFar - vFogDist) / (uFogFar - uFogNear), 0.0, 1.0);
    color = mix(uFogColor, color, fogFactor);
    fragColor = vec4(color, texColor.a);
}
`;

export const GLOW_VS = `
    attribute vec3 aPosition;
    uniform mat4 uModel;
    uniform mat4 uView;
    uniform mat4 uProjection;
    void main() {
        gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
    }
`;

export const GLOW_FS = `
    precision mediump float;
    uniform vec4 uColor;
    void main() {
        gl_FragColor = uColor;
    }
`;

export const PARTICLE_VS = `
    attribute vec3 aCenterPos;
    attribute vec2 aOffset;
    attribute vec2 aTexCoord;
    attribute float aSize;
    attribute float aBlockType;
    uniform mat4 uView;
    uniform mat4 uProjection;
    varying vec2 vTexCoord;
    varying float vBlockType;
    void main() {
        vTexCoord = aTexCoord;
        vBlockType = aBlockType;
        vec4 viewPos = uView * vec4(aCenterPos, 1.0);
        viewPos.xy += aOffset * aSize;
        gl_Position = uProjection * viewPos;
    }
`;

export const PARTICLE_FS = `
    precision mediump float;
    varying vec2 vTexCoord;
    varying float vBlockType;
    uniform sampler2D uTexture;
    void main() {
        // WebGL1 fallback: atlas lookup (0=stone, 1=dirt, 2=grass, 3=grass_top, 4=log_side, 5=log_top, 6=leaves, 7=water)
        float tile  = 1.0 / 8.0;
        float padU  = 0.125 / 128.0; // 1/8 texel of the 128px-wide atlas
        float padV  = 0.125 / 16.0;
        vec2 atlasCoord = vec2(
            vBlockType * tile + padU + vTexCoord.x * (tile - 2.0 * padU),
            padV + vTexCoord.y * (1.0 - 2.0 * padV)
        );
        vec4 tex = texture2D(uTexture, atlasCoord);
        gl_FragColor = tex;
    }
`;

export const PARTICLE_VS_ARRAY = `#version 300 es
precision highp float;
in vec3 aCenterPos;
in vec2 aOffset;
in vec2 aTexCoord;
in float aSize;
in float aBlockType;
uniform mat4 uView;
uniform mat4 uProjection;
out vec2 vTexCoord;
out float vBlockType;
void main() {
    vTexCoord = aTexCoord;
    vBlockType = aBlockType;
    vec4 viewPos = uView * vec4(aCenterPos, 1.0);
    viewPos.xy += aOffset * aSize;
    gl_Position = uProjection * viewPos;
}
`;

export const PARTICLE_FS_ARRAY = `#version 300 es
precision highp float;
in vec2 vTexCoord;
in float vBlockType;
uniform highp sampler2DArray uTexture;
out vec4 fragColor;
void main() {
    fragColor = texture(uTexture, vec3(vTexCoord, vBlockType));
}
`;

function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

export function createProgram(gl, vsSource, fsSource) {
    const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
    const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(program));
        return null;
    }
    return program;
}
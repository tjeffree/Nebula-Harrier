import * as THREE from 'three';

/**
 * Uniforms shared by every procedural material. Mutating `.value` here
 * propagates to all materials without re-binding.
 */
export const globalUniforms = {
  uTime: { value: 0 },
  uScroll: { value: 0 },
  /** Atmospheric haze; also the sky colour at the horizon. */
  uFogColor: { value: new THREE.Color(0xcdeeff) },
  uFogNear: { value: 60 },
  uFogFar: { value: 210 },
  uSkyTop: { value: new THREE.Color(0x2f8cff) },
  uGroundA: { value: new THREE.Color(0x7fd65a) },
  uGroundB: { value: new THREE.Color(0x63c24a) },
  /** Primary / secondary accent colours of the current sector. */
  uPalA: { value: new THREE.Color(0xff4f9a) },
  uPalB: { value: new THREE.Color(0xffd23f) },
  uSunDir: { value: new THREE.Vector3(0.35, 0.8, 0.45).normalize() },
  uSunColor: { value: new THREE.Color(0xfff4dc) },
  uWarp: { value: 0 },
};

const FOG_PARS = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
`;

/** Shared rolling-hill height field (also mirrored in TS by groundHeight). */
const HILLS_GLSL = /* glsl */ `
float hills(float x, float zs) {
  float ax = abs(x);
  float side = smoothstep(15.0, 60.0, ax);
  float roll = 0.55 + 0.45 * sin(zs * 0.045 + x * 0.07) * cos(zs * 0.021 - x * 0.05);
  return side * side * (10.0 + 14.0 * side) * roll + side * 1.5;
}
`;

// ---------------------------------------------------------------------------
// Toon material: soft two-band cel lighting, hemisphere ambient, glossy toon
// specular and a Fresnel rim (edge-gaze glow, clamp(1 - N·V)^2.5) so shapes
// pop against bright skies without any post-processing bloom.
// ---------------------------------------------------------------------------
const TOON_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vWPos;
varying vec3 vTint;
varying float vDist;
void main() {
  vec4 lp = vec4(position, 1.0);
  vec3 n = normal;
  #ifdef USE_INSTANCING
    lp = instanceMatrix * lp;
    n = mat3(instanceMatrix) * n;
  #endif
  vTint = vec3(1.0);
  #ifdef USE_INSTANCING_COLOR
    vTint = instanceColor;
  #endif
  #ifdef USE_COLOR
    vTint *= color;
  #endif
  vec4 wp = modelMatrix * lp;
  vWPos = wp.xyz;
  vN = normalize(mat3(modelMatrix) * n);
  vec4 mv = viewMatrix * wp;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const TOON_FRAG = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uEdge;
uniform float uGloss;
uniform float uEmissive;
uniform float uFlash;
uniform float uOpacity;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyTop;
uniform vec3 uGroundA;
${FOG_PARS}
varying vec3 vN;
varying vec3 vWPos;
varying vec3 vTint;
varying float vDist;
void main() {
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vWPos);
  vec3 L = normalize(uSunDir);
  vec3 base = uBase * vTint;
  float ndl = dot(N, L);
  // Two soft cel bands.
  float diff = smoothstep(-0.1, 0.05, ndl) * 0.55 + smoothstep(0.35, 0.5, ndl) * 0.45;
  vec3 amb = mix(uGroundA * 0.55 + 0.25, uSkyTop * 0.5 + 0.5, N.y * 0.5 + 0.5) * 0.5;
  vec3 col = base * (amb + uSunColor * diff * 0.75);
  // Toon specular highlight.
  vec3 H = normalize(L + V);
  col += smoothstep(0.9, 0.95, dot(N, H)) * uGloss * 0.8;
  // Fresnel rim light.
  float rim = pow(clamp(1.0 - dot(N, V), 0.0, 1.0), 2.5);
  col += uEdge * rim * 0.75;
  col = mix(col, base * 1.15 + 0.1, uEmissive);
  col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));
  float f = smoothstep(uFogNear, uFogFar, vDist);
  gl_FragColor = vec4(mix(col, uFogColor, f), uOpacity);
}
`;

export interface ToonOptions {
  color: THREE.ColorRepresentation;
  /** Rim-light colour (defaults to white). */
  rim?: THREE.ColorRepresentation;
  gloss?: number;
  emissive?: number;
  opacity?: number;
  vertexColors?: boolean;
}

export function createToonMaterial(o: ToonOptions): THREE.ShaderMaterial {
  const opacity = o.opacity ?? 1;
  return new THREE.ShaderMaterial({
    uniforms: {
      uBase: { value: new THREE.Color(o.color) },
      uEdge: { value: new THREE.Color(o.rim ?? 0xffffff) },
      uGloss: { value: o.gloss ?? 0.6 },
      uEmissive: { value: o.emissive ?? 0 },
      uFlash: { value: 0 },
      uOpacity: { value: opacity },
      uSunDir: globalUniforms.uSunDir,
      uSunColor: globalUniforms.uSunColor,
      uSkyTop: globalUniforms.uSkyTop,
      uGroundA: globalUniforms.uGroundA,
      uFogColor: globalUniforms.uFogColor,
      uFogNear: globalUniforms.uFogNear,
      uFogFar: globalUniforms.uFogFar,
    },
    vertexShader: TOON_VERT,
    fragmentShader: TOON_FRAG,
    vertexColors: o.vertexColors ?? false,
    transparent: opacity < 1,
  });
}

// ---------------------------------------------------------------------------
// Terrain: infinite scrolling soft checker meadow with rolling side hills and
// planetary curvature (vertices pulled down quadratically with distance).
// ---------------------------------------------------------------------------
export function createGroundMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCurve: { value: 0.0012 },
      uScroll: globalUniforms.uScroll,
      uTime: globalUniforms.uTime,
      uGroundA: globalUniforms.uGroundA,
      uGroundB: globalUniforms.uGroundB,
      uPalA: globalUniforms.uPalA,
      uPalB: globalUniforms.uPalB,
      uSunDir: globalUniforms.uSunDir,
      uFogColor: globalUniforms.uFogColor,
      uFogNear: globalUniforms.uFogNear,
      uFogFar: globalUniforms.uFogFar,
    },
    vertexShader: /* glsl */ `
      uniform float uCurve;
      uniform float uScroll;
      varying vec3 vW;
      varying vec3 vN;
      varying float vDist;
      ${HILLS_GLSL}
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        float zs = wp.z - uScroll;
        float h0 = hills(wp.x, zs);
        // Central differences give a smooth normal (no faceting on the hills).
        float e = 0.75;
        float hx = (hills(wp.x + e, zs) - hills(wp.x - e, zs)) / (2.0 * e);
        float hz = (hills(wp.x, zs + e) - hills(wp.x, zs - e)) / (2.0 * e);
        float d = max(0.0, -wp.z - 30.0);
        hz += 2.0 * d * uCurve;
        vN = normalize(vec3(-hx, 1.0, -hz));
        wp.y += h0;
        wp.y -= d * d * uCurve;
        vW = vec3(wp.x, wp.y, zs);
        vec4 mv = viewMatrix * wp;
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uGroundA;
      uniform vec3 uGroundB;
      uniform vec3 uPalA;
      uniform vec3 uPalB;
      uniform vec3 uSunDir;
      uniform float uTime;
      ${FOG_PARS}
      varying vec3 vW;
      varying vec3 vN;
      varying float vDist;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec2 p = vW.xz;
        // Soft, anti-aliased checker (the classic rail-shooter speed cue).
        vec2 q = p / 7.0;
        vec2 w = fwidth(q) * 1.5;
        vec2 s = smoothstep(-w, w, sin(q * 3.14159) * 0.5);
        float checker = s.x * s.y + (1.0 - s.x) * (1.0 - s.y);
        vec3 col = mix(uGroundA, uGroundB, checker);
        // Organic tonal patches.
        float n = noise(p * 0.05) * 0.6 + noise(p * 0.21) * 0.4;
        col *= 0.9 + n * 0.2;
        // Lighting from the actual surface slope (hills).
        vec3 N = normalize(vN);
        float ndl = clamp(dot(N, normalize(uSunDir)), 0.0, 1.0);
        col *= 0.7 + 0.45 * smoothstep(0.2, 0.9, ndl);
        // Scattered flower dots on the meadow.
        vec2 fc = floor(p / 2.5);
        float h = hash(fc);
        vec2 fp = fract(p / 2.5) - 0.5 - (vec2(hash(fc + 3.1), hash(fc + 7.7)) - 0.5) * 0.6;
        float flower = step(0.86, h) * smoothstep(0.12, 0.06, length(fp)) * (1.0 - smoothstep(60.0, 110.0, vDist));
        col = mix(col, mix(uPalA, uPalB, step(0.93, h)), flower * 0.9);
        float f = smoothstep(uFogNear, uFogFar, vDist);
        gl_FragColor = vec4(mix(col, uFogColor, f), 1.0);
      }`,
  });
}

// ---------------------------------------------------------------------------
// Daytime sky dome: gradient, sun with glow, drifting cumulus and a big
// ringed planet hanging over the horizon.
// ---------------------------------------------------------------------------
export function createSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: globalUniforms.uTime,
      uSkyTop: globalUniforms.uSkyTop,
      uFogColor: globalUniforms.uFogColor,
      uPalA: globalUniforms.uPalA,
      uPalB: globalUniforms.uPalB,
      uSunColor: globalUniforms.uSunColor,
      uScroll: globalUniforms.uScroll,
      uWarp: globalUniforms.uWarp,
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSkyTop;
      uniform vec3 uFogColor;
      uniform vec3 uPalA;
      uniform vec3 uPalB;
      uniform vec3 uSunColor;
      uniform float uScroll;
      uniform float uWarp;
      varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 3; i++) { v += a * noise(p); p = p * 2.03 + 1.7; a *= 0.5; }
        return v;
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uFogColor, uSkyTop, pow(smoothstep(-0.02, 0.75, h), 0.65));

        // Ringed planet.
        vec3 pc = normalize(vec3(-0.55, 0.32, -1.0));
        vec3 pu = normalize(cross(pc, vec3(0.0, 1.0, 0.0)));
        vec3 pv = cross(pu, pc);
        vec2 pp = vec2(dot(d, pu), dot(d, pv)) / 0.16;
        float pr = length(pp);
        if (dot(d, pc) > 0.0) {
          vec2 rp = vec2(pp.x * 0.92 + pp.y * 0.4, (pp.y - pp.x * 0.35) * 3.6);
          float rr = length(rp);
          float ring = smoothstep(1.3, 1.35, rr) * smoothstep(2.05, 1.95, rr) * (0.75 + 0.25 * sin(rr * 40.0));
          vec3 ringCol = mix(uPalB, vec3(1.0), 0.45);
          bool ringFront = rp.y > 0.0;
          if (!ringFront) col = mix(col, ringCol, ring * 0.55);
          if (pr < 1.0) {
            float band = sin(pp.y * 9.0 + sin(pp.x * 3.0) * 0.6);
            vec3 pcol = mix(mix(uPalA, vec3(1.0), 0.45), mix(uPalA, uPalB, 0.5), band * 0.5 + 0.5);
            float shade = smoothstep(-0.9, 0.6, -pp.x * 0.7 + pp.y * 0.7);
            pcol *= 0.7 + 0.3 * shade;
            float limb = smoothstep(1.0, 0.96, pr);
            col = mix(col, pcol, limb * 0.85);
          }
          if (ringFront) col = mix(col, ringCol, ring * 0.7);
        }

        // Sun.
        vec3 sd = normalize(vec3(0.38, 0.22, -1.0));
        float s = max(dot(d, sd), 0.0);
        col += uSunColor * (pow(s, 12.0) * 0.35 + pow(s, 120.0) * 0.6);
        col = mix(col, vec3(1.0, 0.99, 0.92), smoothstep(0.9990, 0.9994, s));

        // Cumulus layer projected onto a high plane, drifting with the rail.
        if (h > 0.0) {
          vec2 cp = d.xz / (h + 0.08) * 0.9 + vec2(uTime * 0.01, -uScroll * 0.0025);
          float c = fbm(cp * 0.9);
          float cloud = smoothstep(0.5, 0.72, c) * smoothstep(0.0, 0.12, h);
          float lit = smoothstep(0.45, 0.85, fbm(cp * 0.9 + vec2(0.06, 0.09)));
          vec3 cc = mix(vec3(1.0), mix(uSkyTop, vec3(1.0), 0.55), lit * 0.8);
          col = mix(col, cc, cloud * 0.92);
        }

        // Warp: stretched light streaks.
        if (uWarp > 0.01) {
          vec2 sp = vec2(atan(d.x, -d.z) * 60.0, h * 4.0);
          float streak = step(0.985, hash(floor(sp))) * uWarp;
          col = mix(col, vec3(1.0), streak);
        }
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Instanced billboard sprite shader sampling the baked atlas.
// Per-instance: aPos (xyz), aParams (cell, sizeX, sizeY, rotation), aColor (rgba).
// Tintable cells decode rgb = mix(tint, white, tex.r) * tex.g; the explosion
// flipbook cells are baked in full colour.
// ---------------------------------------------------------------------------
export function createSpriteMaterial(atlas: THREE.Texture, cols: number, fullColorStart: number, fullColorEnd: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlas },
      uCols: { value: cols },
      uFull: { value: new THREE.Vector2(fullColorStart, fullColorEnd) },
      uFogColor: globalUniforms.uFogColor,
      uFogNear: globalUniforms.uFogNear,
      uFogFar: globalUniforms.uFogFar,
    },
    vertexShader: /* glsl */ `
      attribute vec3 aPos;
      attribute vec4 aParams;
      attribute vec4 aColor;
      uniform float uCols;
      uniform vec2 uFull;
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec2 vUv;
      varying vec4 vColor;
      varying float vFull;
      varying float vFog;
      void main() {
        vec4 center = modelViewMatrix * vec4(aPos, 1.0);
        float c = cos(aParams.w), s = sin(aParams.w);
        vec2 q = position.xy * aParams.yz;
        center.xy += vec2(c * q.x - s * q.y, s * q.x + c * q.y);
        gl_Position = projectionMatrix * center;
        float col = mod(aParams.x, uCols);
        float row = floor(aParams.x / uCols);
        vUv = vec2((col + uv.x) / uCols, 1.0 - (row + 1.0 - uv.y) / uCols);
        vFull = step(uFull.x - 0.5, aParams.x) * step(aParams.x, uFull.y + 0.5);
        vFog = smoothstep(uFogNear, uFogFar, -center.z);
        vColor = aColor;
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform vec3 uFogColor;
      varying vec2 vUv;
      varying vec4 vColor;
      varying float vFull;
      varying float vFog;
      void main() {
        vec4 t = texture2D(uAtlas, vUv);
        vec3 tinted = mix(vColor.rgb, vec3(1.0), t.r) * t.g;
        vec3 rgb = mix(tinted, t.rgb, vFull);
        float a = t.a * vColor.a;
        if (a < 0.01) discard;
        gl_FragColor = vec4(mix(rgb, uFogColor, vFog * 0.85), a);
      }`,
    transparent: true,
    depthWrite: false,
  });
}

/** Soft round contact shadow (decal on the ground). */
export function createBlobShadowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0.35 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        gl_FragColor = vec4(0.05, 0.1, 0.2, smoothstep(1.0, 0.2, d) * uOpacity);
      }`,
    transparent: true,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Final full-screen pass: gentle colour grade, vignette, damage tint and the
// radial warp blur. (Replaces the earlier CRT raster pass.)
// ---------------------------------------------------------------------------
export function createGradeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uDamage: { value: 0 },
      uWarp: globalUniforms.uWarp,
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float uDamage;
      uniform float uWarp;
      varying vec2 vUv;
      void main() {
        vec2 uv = vUv;
        vec2 pos = uv - 0.5;
        vec3 col = texture2D(tDiffuse, uv).rgb;
        if (uWarp > 0.01) {
          vec3 acc = col;
          for (int i = 1; i <= 4; i++) acc += texture2D(tDiffuse, uv - pos * 0.025 * float(i) * uWarp).rgb;
          col = mix(col, acc / 5.0, uWarp) + uWarp * 0.12;
        }
        // Gentle vibrance + contrast.
        float l = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(vec3(l), col, 1.12);
        col = (col - 0.5) * 1.04 + 0.5;
        float v = smoothstep(0.95, 0.35, length(pos * vec2(1.0, 1.2)));
        col *= mix(0.82, 1.0, v);
        col = mix(col, vec3(1.0, 0.15, 0.25), uDamage * (1.0 - v) * 0.85);
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
}

/** CPU mirror of the terrain vertex shader (hills + curvature) so props sit on the ground. */
export function terrainY(x: number, z: number, scroll: number, curve = 0.0012): number {
  const zs = z - scroll;
  const ax = Math.abs(x);
  const t = Math.min(1, Math.max(0, (ax - 15) / 45));
  const side = t * t * (3 - 2 * t);
  const roll = 0.55 + 0.45 * Math.sin(zs * 0.045 + x * 0.07) * Math.cos(zs * 0.021 - x * 0.05);
  const d = Math.max(0, -z - 30);
  return side * side * (10 + 14 * side) * roll + side * 1.5 - d * d * curve;
}

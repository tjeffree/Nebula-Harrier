import * as THREE from 'three';

/**
 * Uniforms shared by every procedural material. Mutating `.value` here
 * propagates to all materials without re-binding.
 */
export const globalUniforms = {
  uTime: { value: 0 },
  uScroll: { value: 0 },
  uFogColor: { value: new THREE.Color(0x1a0630) },
  uFogNear: { value: 45 },
  uFogFar: { value: 175 },
  uPalA: { value: new THREE.Color(0x29f0ff) },
  uPalB: { value: new THREE.Color(0xff2bd6) },
  uWarp: { value: 0 },
};

const FOG_PARS = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
`;

// ---------------------------------------------------------------------------
// Edge-gaze crystal material: Fresnel self-illumination, no bloom pass.
//   Intensity = clamp(1 - N.V, 0, 1)^2.5
// ---------------------------------------------------------------------------
const CRYSTAL_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
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
  vec4 wp = modelMatrix * lp;
  vWPos = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vN = normalize(normalMatrix * n);
  vV = -mv.xyz;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const CRYSTAL_FRAG = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uEdge;
uniform float uIri;
uniform float uFlash;
uniform float uOpacity;
uniform float uTime;
${FOG_PARS}
varying vec3 vN;
varying vec3 vV;
varying vec3 vWPos;
varying vec3 vTint;
varying float vDist;
void main() {
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(vV);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fres = pow(clamp(1.0 - ndv, 0.0, 1.0), 2.5);
  vec3 iri = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + ndv * 1.3 + vWPos.y * 0.07 + uTime * 0.04));
  float key = clamp(dot(N, normalize(vec3(0.35, 0.8, 0.45))), 0.0, 1.0);
  vec3 col = uBase * (0.25 + 0.75 * key) + iri * uIri * (1.0 - ndv) * 0.45;
  col += uEdge * vTint * fres * 2.4;
  col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));
  float f = smoothstep(uFogNear, uFogFar, vDist);
  gl_FragColor = vec4(mix(col, uFogColor, f), uOpacity);
}
`;

export interface CrystalOptions {
  base: THREE.ColorRepresentation;
  edge: THREE.ColorRepresentation;
  iridescence?: number;
  opacity?: number;
}

export function createCrystalMaterial(o: CrystalOptions): THREE.ShaderMaterial {
  const opacity = o.opacity ?? 1;
  return new THREE.ShaderMaterial({
    uniforms: {
      uBase: { value: new THREE.Color(o.base) },
      uEdge: { value: new THREE.Color(o.edge) },
      uIri: { value: o.iridescence ?? 0.6 },
      uFlash: { value: 0 },
      uOpacity: { value: opacity },
      uTime: globalUniforms.uTime,
      uFogColor: globalUniforms.uFogColor,
      uFogNear: globalUniforms.uFogNear,
      uFogFar: globalUniforms.uFogFar,
    },
    vertexShader: CRYSTAL_VERT,
    fragmentShader: CRYSTAL_FRAG,
    transparent: opacity < 1,
    side: THREE.FrontSide,
  });
}

// ---------------------------------------------------------------------------
// Neon line material (for EdgesGeometry wireframes) with distance fog.
// ---------------------------------------------------------------------------
export function createNeonLineMaterial(color: THREE.ColorRepresentation, intensity = 1.6): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color).multiplyScalar(intensity) },
      uFlash: { value: 0 },
      uFogColor: globalUniforms.uFogColor,
      uFogNear: globalUniforms.uFogNear,
      uFogFar: globalUniforms.uFogFar,
    },
    vertexShader: /* glsl */ `
      varying float vDist;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uFlash;
      ${FOG_PARS}
      varying float vDist;
      void main() {
        float f = smoothstep(uFogNear, uFogFar, vDist);
        vec3 c = mix(uColor, vec3(1.0), uFlash);
        gl_FragColor = vec4(c * (1.0 - f), 1.0 - f);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Horizon grid: infinite scrolling checker / stepped terrain on a 60x200 plane.
// Vertices are pulled down quadratically with distance (planetary curvature).
// ---------------------------------------------------------------------------
export function createGroundMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCurve: { value: 0.0016 },
      uScroll: globalUniforms.uScroll,
      uTime: globalUniforms.uTime,
      uPalA: globalUniforms.uPalA,
      uPalB: globalUniforms.uPalB,
      uFogColor: globalUniforms.uFogColor,
      uFogNear: globalUniforms.uFogNear,
      uFogFar: globalUniforms.uFogFar,
    },
    vertexShader: /* glsl */ `
      uniform float uCurve;
      varying vec2 vW;
      varying float vDist;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        float d = max(0.0, -wp.z - 25.0);
        wp.y -= d * d * uCurve;
        vW = wp.xz;
        vec4 mv = viewMatrix * wp;
        vDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uScroll;
      uniform float uTime;
      uniform vec3 uPalA;
      uniform vec3 uPalB;
      ${FOG_PARS}
      varying vec2 vW;
      varying float vDist;
      void main() {
        vec2 p = vec2(vW.x, vW.y - uScroll);
        vec2 cell = floor(p / 4.0);
        float checker = mod(cell.x + cell.y, 2.0);
        // Stepped bands every 32 units give the "terraced" super-scaler read.
        float band = floor(mod(p.y / 32.0, 4.0)) / 3.0;
        vec3 dark = mix(vec3(0.035, 0.01, 0.07), vec3(0.06, 0.015, 0.11), band);
        vec3 col = mix(dark, dark * 2.2 + uPalB * 0.05, checker);
        // Anti-aliased grid lines.
        vec2 gp = p / 4.0;
        vec2 g = abs(fract(gp - 0.5) - 0.5) / fwidth(gp);
        float line = 1.0 - min(min(g.x, g.y), 1.0);
        col += uPalA * line * 0.75;
        // Major lines every band.
        float major = 1.0 - min(abs(fract(p.y / 32.0 - 0.5) - 0.5) / fwidth(p.y / 32.0), 1.0);
        col += uPalB * major * 0.9;
        // Corridor edge rails.
        float ax = abs(vW.x);
        float rail = smoothstep(27.0, 29.6, ax);
        col += uPalB * rail * (0.6 + 0.4 * sin(p.y * 0.25 + uTime * 6.0));
        float f = smoothstep(uFogNear, uFogFar, vDist);
        float edgeFade = 1.0 - smoothstep(29.4, 30.0, ax);
        gl_FragColor = vec4(mix(col, uFogColor, f), edgeFade);
      }`,
    transparent: true,
    depthWrite: true,
  });
}

// ---------------------------------------------------------------------------
// Nebula sky dome with retro sun and starfield.
// ---------------------------------------------------------------------------
export function createSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: globalUniforms.uTime,
      uPalA: globalUniforms.uPalA,
      uPalB: globalUniforms.uPalB,
      uFogColor: globalUniforms.uFogColor,
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
      uniform vec3 uPalA;
      uniform vec3 uPalB;
      uniform vec3 uFogColor;
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
        for (int i = 0; i < 3; i++) { v += a * noise(p); p *= 2.07; a *= 0.5; }
        return v;
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec2 sp = vec2(atan(d.x, -d.z), h);
        vec3 col = mix(uFogColor, vec3(0.01, 0.0, 0.03), smoothstep(0.0, 0.6, h));
        col = mix(col, uFogColor * 0.6, smoothstep(0.0, -0.3, h));
        // Nebula clouds.
        float n = fbm(sp * vec2(3.0, 5.0) + vec2(uTime * 0.01, 0.0));
        float n2 = fbm(sp * vec2(6.0, 9.0) - vec2(uTime * 0.015, 0.0));
        float neb = smoothstep(0.45, 0.85, n) * smoothstep(-0.05, 0.25, h);
        col += mix(uPalB, uPalA, n2) * neb * 0.35;
        // Stars (twinkling hash grid), stretched during warp.
        vec2 sg = sp * vec2(220.0, 220.0 / (1.0 + uWarp * 6.0));
        float s = hash(floor(sg));
        float star = step(0.993, s) * smoothstep(0.02, 0.2, h) * (0.6 + 0.4 * sin(uTime * 3.0 + s * 50.0));
        col += vec3(star);
        // Retro striped sun sitting on the horizon.
        vec2 sd = vec2(sp.x * 1.4, h - 0.07);
        float sr = length(sd);
        float sun = smoothstep(0.17, 0.165, sr);
        float stripes = step(0.0, sin((h - 0.07) * 160.0 - uTime * 2.0)) + step(0.06, h);
        sun *= clamp(stripes, 0.0, 1.0) * step(-0.005, h);
        vec3 sunCol = mix(uPalB, vec3(1.0, 0.85, 0.35), smoothstep(-0.02, 0.2, h));
        col = mix(col, sunCol * 1.1, sun);
        col += uPalB * exp(-sr * 9.0) * 0.25;
        // Horizon glow band.
        col += uPalB * exp(-abs(h) * 28.0) * 0.45;
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Instanced billboard sprite shader sampling the baked atlas.
// Per-instance: aPos (xyz), aParams (cell, sizeX, sizeY, rotation), aColor (rgba).
// ---------------------------------------------------------------------------
export function createSpriteMaterial(atlas: THREE.Texture, cols: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uAtlas: { value: atlas },
      uCols: { value: cols },
      uFogColor: globalUniforms.uFogColor,
      uFogNear: globalUniforms.uFogNear,
      uFogFar: globalUniforms.uFogFar,
    },
    vertexShader: /* glsl */ `
      attribute vec3 aPos;
      attribute vec4 aParams;
      attribute vec4 aColor;
      uniform float uCols;
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec2 vUv;
      varying vec4 vColor;
      void main() {
        vec4 center = modelViewMatrix * vec4(aPos, 1.0);
        float c = cos(aParams.w), s = sin(aParams.w);
        vec2 q = position.xy * aParams.yz;
        center.xy += vec2(c * q.x - s * q.y, s * q.x + c * q.y);
        gl_Position = projectionMatrix * center;
        float col = mod(aParams.x, uCols);
        float row = floor(aParams.x / uCols);
        vUv = vec2((col + uv.x) / uCols, 1.0 - (row + 1.0 - uv.y) / uCols);
        float fog = smoothstep(uFogNear, uFogFar, -center.z);
        vColor = vec4(aColor.rgb, aColor.a * (1.0 - fog * 0.85));
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      varying vec2 vUv;
      varying vec4 vColor;
      void main() {
        vec4 t = texture2D(uAtlas, vUv);
        gl_FragColor = vec4(t.rgb * vColor.rgb, t.a * vColor.a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// ---------------------------------------------------------------------------
// CRT raster / scanline / chromatic aberration full-screen pass.
// ---------------------------------------------------------------------------
export function createCrtMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: globalUniforms.uTime,
      uDamage: { value: 0 },
      uWarp: globalUniforms.uWarp,
      uScan: { value: 0.22 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec2 uRes;
      uniform float uTime;
      uniform float uDamage;
      uniform float uWarp;
      uniform float uScan;
      varying vec2 vUv;
      void main() {
        vec2 uv = vUv;
        vec2 pos = uv - 0.5;
        vec2 offset = 0.002 * pos * (1.0 + uWarp * 10.0 + uDamage * 4.0);
        vec3 col;
        col.r = texture2D(tDiffuse, uv + offset).r;
        col.g = texture2D(tDiffuse, uv).g;
        col.b = texture2D(tDiffuse, uv - offset).b;
        if (uWarp > 0.01) {
          // Cheap radial streak for warp transitions.
          col += texture2D(tDiffuse, uv - pos * 0.04 * uWarp).rgb * 0.5 * uWarp;
          col += texture2D(tDiffuse, uv - pos * 0.08 * uWarp).rgb * 0.3 * uWarp;
        }
        float scan = sin(uv.y * uRes.y * 3.14159);
        col *= 1.0 - uScan * (0.5 - 0.5 * scan);
        float v = smoothstep(0.85, 0.3, length(pos * vec2(1.0, 1.15)));
        col *= mix(0.55, 1.0, v);
        col = mix(col, vec3(1.0, 0.05, 0.25), uDamage * (1.0 - v) * 0.8);
        gl_FragColor = vec4(col, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  });
}

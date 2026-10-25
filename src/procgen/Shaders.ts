import * as THREE from 'three';

/**
 * Uniforms shared by every procedural material. Mutating `.value` here
 * propagates to all materials without re-binding. Colours are linear
 * (ColorManagement converts the authored sRGB hex values on `.set()`).
 */
export const globalUniforms = {
  uTime: { value: 0 },
  uScroll: { value: 0 },
  /** Aerial haze: fog colour and the sky right at the horizon. */
  uFogColor: { value: new THREE.Color(0xe2b38a) },
  uFogNear: { value: 45 },
  uFogFar: { value: 235 },
  /** Sky zenith and the band just above the haze. */
  uSkyTop: { value: new THREE.Color(0x47689a) },
  uHorizon: { value: new THREE.Color(0xf0b483) },
  /** Terrain: flat ground and exposed rock. */
  uGroundA: { value: new THREE.Color(0x8a7148) },
  uGroundB: { value: new THREE.Color(0xa7835a) },
  /** Primary / secondary accent colours of the current sector. */
  uPalA: { value: new THREE.Color(0xc9372c) },
  uPalB: { value: new THREE.Color(0xe8742c) },
  /** Direction toward the sun disc as drawn in the sky. */
  uSunDir: { value: new THREE.Vector3(0.42, 0.075, -1).normalize() },
  uSunColor: { value: new THREE.Color(0xffd6a0) },
  uSunSize: { value: 0.0009 },
  uSunGlow: { value: 1 },
  uClouds: { value: 0.5 },
  uCloudLit: { value: new THREE.Color(0xffe4c4) },
  uCloudShade: { value: new THREE.Color(0x8b7f92) },
  uRidgeFar: { value: new THREE.Color(0xc8957c) },
  uRidgeNear: { value: new THREE.Color(0x8b6a5e) },
  uStars: { value: 0 },
  uWarp: { value: 0 },
};

/**
 * Rugged canyon height field: rolling side walls plus ridged sine octaves.
 * Mirrored exactly in TS by {@link terrainY} so props sit on the ground.
 * Sines (not hashed noise) keep the CPU and GPU results identical.
 */
const TERRAIN_GLSL = /* glsl */ `
float terrainH(float x, float zs) {
  float side = smoothstep(14.0, 58.0, abs(x));
  float roll = 0.5 + 0.5 * sin(zs * 0.045 + x * 0.07) * cos(zs * 0.021 - x * 0.05);
  float r1 = 1.0 - abs(sin(zs * 0.11 + x * 0.13) * cos(zs * 0.07 - x * 0.09 + 1.3));
  float r2 = 1.0 - abs(sin(zs * 0.23 - x * 0.19 + 2.1) * cos(zs * 0.17 + x * 0.21));
  float ridge = r1 * r1 * 0.65 + r2 * r2 * 0.35;
  return side * side * (8.0 + 18.0 * side) * (0.45 + 0.55 * roll) + side * ridge * 10.0 + side * 1.2;
}
`;

const NOISE_GLSL = /* glsl */ `
float nhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(nhash(i), nhash(i + vec2(1, 0)), f.x), mix(nhash(i + vec2(0, 1)), nhash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 1.7; a *= 0.5; }
  return v / 0.97;
}
`;

// ---------------------------------------------------------------------------
// Surface material: MeshStandardMaterial (physically based, shadowed, fogged,
// lit by the sun, the sky hemisphere and sky reflections) with two hooks:
// a Fresnel edge light (uEdge) and a hit flash that blooms to white (uFlash).
// ---------------------------------------------------------------------------
export interface SurfaceUniforms {
  uFlash: { value: number };
  uEdge: { value: THREE.Color };
  uRim: { value: number };
}
export type SurfaceMaterial = THREE.MeshStandardMaterial & { uniforms: SurfaceUniforms };

export interface SurfaceOptions {
  color: THREE.ColorRepresentation;
  /** Fresnel edge-light colour (defaults to a warm sky tint). */
  rim?: THREE.ColorRepresentation;
  /** Edge-light strength. */
  rimStrength?: number;
  roughness?: number;
  metalness?: number;
  /** 0..1: how much the base colour glows on its own (HDR, feeds bloom). */
  emissive?: number;
  opacity?: number;
  vertexColors?: boolean;
  flatShading?: boolean;
}

export function createSurfaceMaterial(o: SurfaceOptions): SurfaceMaterial {
  const opacity = o.opacity ?? 1;
  const glow = o.emissive ?? 0;
  const mat = new THREE.MeshStandardMaterial({
    color: o.color,
    roughness: o.roughness ?? 0.55,
    metalness: o.metalness ?? 0.1,
    emissive: glow > 0 ? new THREE.Color(o.color) : new THREE.Color(0x000000),
    emissiveIntensity: glow * 4,
    vertexColors: o.vertexColors ?? false,
    flatShading: o.flatShading ?? false,
    transparent: opacity < 1,
    opacity,
  }) as SurfaceMaterial;
  const uniforms: SurfaceUniforms = {
    uFlash: { value: 0 },
    uEdge: { value: new THREE.Color(o.rim ?? 0xffd2a8) },
    uRim: { value: o.rimStrength ?? 0.35 },
  };
  mat.uniforms = uniforms;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uFlash;\nuniform vec3 uEdge;\nuniform float uRim;')
      .replace(
        '#include <opaque_fragment>',
        `{
          float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
          outgoingLight += uEdge * fres * uRim;
          outgoingLight = mix(outgoingLight, vec3(3.0, 2.9, 2.7), saturate(uFlash) * 0.75);
        }
        #include <opaque_fragment>`,
      );
  };
  return mat;
}

/**
 * Instanced hard-surface material for swarm enemies. A per-vertex `aTint`
 * attribute picks the part: 0 = neutral hull, 1 = accent panel (instance
 * colour), 2 = glowing sensor (instance colour, HDR). When the instance
 * colour is driven to white (hit flash) the hull flashes too.
 */
export function createInstancedHullMaterial(hull: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: hull, roughness: 0.42, metalness: 0.65 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTint;\nvarying float vTint;')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvTint = aTint;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vTint;')
      .replace(
        '#include <color_fragment>',
        `float flashK = smoothstep(0.55, 0.95, min(vColor.r, min(vColor.g, vColor.b)));
        diffuseColor.rgb = mix(diffuseColor.rgb, vColor, step(0.5, vTint));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), flashK);`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vColor * 4.0 * step(1.5, vTint) + flashK * 1.5;');
  };
  return mat;
}

// ---------------------------------------------------------------------------
// Terrain: a scrolling canyon floor. MeshStandardMaterial with the vertex
// stage displaced by the height field (smooth analytic normals, planetary
// curvature) and the albedo built procedurally: sand flats, banded rock on
// slopes, wind ripples and scrub patches that give the speed cue.
// ---------------------------------------------------------------------------
export function createGroundMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, envMapIntensity: 0.35 });
  const u = {
    uCurve: { value: 0.0012 },
    uScroll: globalUniforms.uScroll,
    uGroundA: globalUniforms.uGroundA,
    uGroundB: globalUniforms.uGroundB,
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uCurve;\nuniform float uScroll;\nvarying vec4 vGround;\n${TERRAIN_GLSL}`)
      .replace(
        '#include <beginnormal_vertex>',
        `vec3 gW = (modelMatrix * vec4(position, 1.0)).xyz;
        float gZs = gW.z - uScroll;
        float gH = terrainH(gW.x, gZs);
        float ge = 0.6;
        float ghx = (terrainH(gW.x + ge, gZs) - terrainH(gW.x - ge, gZs)) / (2.0 * ge);
        float ghz = (terrainH(gW.x, gZs + ge) - terrainH(gW.x, gZs - ge)) / (2.0 * ge);
        float gD = max(0.0, -gW.z - 30.0);
        ghz += 2.0 * gD * uCurve;
        vec3 objectNormal = normalize(vec3(-ghx, 1.0, -ghz));
        vGround = vec4(gW.x, gH, gZs, 1.0 - objectNormal.y);`,
      )
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position);\ntransformed.y += gH - gD * gD * uCurve;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec3 uGroundA;\nuniform vec3 uGroundB;\nvarying vec4 vGround;\n${NOISE_GLSL}`)
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec2 gp = vGround.xz;
        float gh = vGround.y;
        float slope = vGround.w;
        float n1 = fbm(gp * 0.035);
        float n2 = vnoise(gp * 0.45);
        float rockK = smoothstep(0.1, 0.38, slope + (n1 - 0.5) * 0.18);
        vec3 sand = uGroundA * (0.82 + 0.32 * n1) * (0.94 + 0.08 * n2);
        // Wind ripples across the rail and darker drift lines along it.
        float ripple = sin(gp.y * 1.6 + n1 * 9.0 + gp.x * 0.15);
        sand *= 0.95 + 0.05 * ripple;
        // Scrub patches: scattered dark tufts, the main sense of speed.
        vec2 cellId = floor(gp / 3.2);
        float hsh = nhash(cellId);
        vec2 off = fract(gp / 3.2) - 0.5 - (vec2(nhash(cellId + 3.1), nhash(cellId + 7.7)) - 0.5) * 0.55;
        float tuft = step(0.72, hsh) * smoothstep(0.2, 0.07, length(off * vec2(1.0, 1.4)));
        sand = mix(sand, uGroundA * vec3(0.42, 0.44, 0.3), tuft * 0.75);
        // Sedimentary bands on exposed rock.
        float band = sin(gh * 2.1 + n1 * 3.0) * 0.5 + 0.5;
        vec3 rock = uGroundB * (0.78 + 0.3 * band) * (0.9 + 0.2 * n2);
        rock = mix(rock, uGroundB * 1.25, smoothstep(0.6, 0.95, band) * 0.4);
        vec4 diffuseColor = vec4(mix(sand, rock, rockK), opacity);`,
      );
  };
  return mat;
}

// ---------------------------------------------------------------------------
// Sky dome: zenith-to-horizon gradient, sun disc and glow, lit cumulus with
// cheap self-shadowing, two ridgelines with aerial perspective, horizon haze,
// optional stars, and the warp streaks.
// ---------------------------------------------------------------------------
export function createSkyMaterial(): THREE.ShaderMaterial {
  const g = globalUniforms;
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: g.uTime,
      uScroll: g.uScroll,
      uSkyTop: g.uSkyTop,
      uHorizon: g.uHorizon,
      uFogColor: g.uFogColor,
      uSunDir: g.uSunDir,
      uSunColor: g.uSunColor,
      uSunSize: g.uSunSize,
      uSunGlow: g.uSunGlow,
      uClouds: g.uClouds,
      uCloudLit: g.uCloudLit,
      uCloudShade: g.uCloudShade,
      uRidgeFar: g.uRidgeFar,
      uRidgeNear: g.uRidgeNear,
      uStars: g.uStars,
      uWarp: g.uWarp,
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uScroll, uSunSize, uSunGlow, uClouds, uStars, uWarp;
      uniform vec3 uSkyTop, uHorizon, uFogColor, uSunDir, uSunColor, uCloudLit, uCloudShade, uRidgeFar, uRidgeNear;
      varying vec3 vDir;
      ${NOISE_GLSL}
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        float az = atan(d.x, -d.z);
        vec3 col = mix(uHorizon, uSkyTop, pow(clamp(h, 0.0, 1.0), 0.45));

        if (uStars > 0.0) {
          vec2 sp = vec2(az * 160.0, h * 160.0);
          float r = nhash(floor(sp));
          float st = step(0.985, r) * smoothstep(0.12, 0.0, length(fract(sp) - 0.5)) * smoothstep(0.08, 0.4, h);
          col += st * uStars * (0.6 + 0.4 * sin(uTime * 2.0 + r * 40.0));
        }

        vec3 sd = normalize(uSunDir);
        float s = max(dot(d, sd), 0.0);
        col += uSunColor * (pow(s, 4.0) * 0.14 + pow(s, 40.0) * 0.45 + pow(s, 400.0) * 1.2) * uSunGlow;
        col = mix(col, uSunColor * 3.5, smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.6, s));

        if (uClouds > 0.0 && h > 0.0) {
          vec2 cp = d.xz / (h + 0.06) * 0.55 + vec2(uTime * 0.004, -uScroll * 0.0011);
          float c = fbm(cp);
          float cov = 1.0 - uClouds;
          float dens = smoothstep(cov, cov + 0.22, c);
          vec2 sdir = normalize(sd.xz + 1e-4);
          float c2 = fbm(cp + vec2(sdir.x, -sdir.y) * 0.09);
          float lit = clamp((c - c2) * 5.0 + 0.55, 0.0, 1.0);
          vec3 cc = mix(uCloudShade, uCloudLit, lit);
          cc += uSunColor * pow(s, 8.0) * 1.2 * (1.0 - dens * 0.6) * uSunGlow;
          col = mix(col, cc, dens * smoothstep(0.0, 0.1, h));
        }

        // Two ridgelines; the far one sinks further into the haze.
        float r1 = 0.01 + pow(fbm(vec2(az * 2.6, 1.3)), 1.6) * 0.11;
        float r2 = 0.003 + pow(fbm(vec2(az * 4.4 + 7.0, 4.1)), 1.8) * 0.07;
        col = mix(col, uRidgeFar, smoothstep(r1, r1 - 0.0015, h));
        col = mix(col, uRidgeNear, smoothstep(r2, r2 - 0.0015, h));

        col = mix(col, uFogColor, exp(-abs(h) * 16.0) * 0.8);
        if (h < 0.0) col = mix(col, uFogColor, smoothstep(0.0, -0.08, h));

        if (uWarp > 0.01) {
          vec2 sp = vec2(az * 60.0, h * 4.0);
          col = mix(col, vec3(2.5), step(0.985, nhash(floor(sp))) * uWarp);
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
// flipbook cells are baked in full colour (sRGB). Output is premultiplied so a
// single blend mode covers both: hot cells add light (bloom picks up their
// white cores), smoke cells cover what is behind them.
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
      varying float vHot;
      void main() {
        vec4 center = modelViewMatrix * vec4(aPos, 1.0);
        float c = cos(aParams.w), s = sin(aParams.w);
        vec2 q = position.xy * aParams.yz;
        center.xy += vec2(c * q.x - s * q.y, s * q.x + c * q.y);
        gl_Position = projectionMatrix * center;
        float cell = aParams.x;
        float col = mod(cell, uCols);
        float row = floor(cell / uCols);
        vUv = vec2((col + uv.x) / uCols, 1.0 - (row + 1.0 - uv.y) / uCols);
        vFull = step(uFull.x - 0.5, cell) * step(cell, uFull.y + 0.5);
        // Projectiles, sparks, mines and rings glow; smoke puffs (15) and the
        // distant enemy silhouette (13) do not.
        vHot = (cell < 3.5 || abs(cell - 12.0) < 0.5 || abs(cell - 14.0) < 0.5) ? 1.0 : 0.0;
        vFog = smoothstep(uFogNear, uFogFar, -center.z);
        // Authored tints are sRGB; values above 1 are deliberate HDR boosts.
        vColor = vec4(pow(max(aColor.rgb, vec3(0.0)), vec3(2.2)), aColor.a);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uAtlas;
      uniform vec3 uFogColor;
      varying vec2 vUv;
      varying vec4 vColor;
      varying float vFull;
      varying float vFog;
      varying float vHot;
      void main() {
        vec4 t = texture2D(uAtlas, vUv);
        float a = t.a * vColor.a;
        if (a < 0.004) discard;
        vec3 tinted = mix(vColor.rgb, vec3(1.0), t.r) * t.g;
        vec3 full = pow(t.rgb, vec3(2.2));
        float fireLum = dot(full, vec3(0.3, 0.55, 0.15));
        vec3 rgb = mix(tinted * (1.0 + vHot * 2.5 * t.r), full * (1.0 + 3.0 * smoothstep(0.45, 0.95, fireLum)), vFull);
        rgb = mix(rgb, uFogColor, vFog * 0.85);
        // Coverage weight: 0 = purely additive glow, 1 = normal alpha blend.
        float cover = mix(mix(1.0, 0.25, vHot), mix(1.0, 0.35, smoothstep(0.5, 0.9, fireLum)), vFull);
        gl_FragColor = vec4(rgb * a, a * cover);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}

/** Soft ambient-occlusion contact blob under the Harrier (the sun casts the real shadow). */
export function createBlobShadowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0.2 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        gl_FragColor = vec4(0.0, 0.0, 0.0, smoothstep(1.0, 0.1, d) * uOpacity);
      }`,
    transparent: true,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Final display-space pass (after tone mapping): warp blur, film grade
// (split tone, lift/gain, saturation, contrast), vignette, chromatic fringe,
// grain and the damage tint.
// ---------------------------------------------------------------------------
export interface GradeSettings {
  lift: [number, number, number];
  gain: [number, number, number];
  shadowTint: [number, number, number];
  highTint: [number, number, number];
  saturation: number;
  contrast: number;
}

export const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: globalUniforms.uTime,
    uDamage: { value: 0 },
    uWarp: globalUniforms.uWarp,
    uLift: { value: new THREE.Vector3(0.035, 0.03, 0.045) },
    uGain: { value: new THREE.Vector3(1.04, 1.0, 0.95) },
    uShadowTint: { value: new THREE.Vector3(-0.01, 0.0, 0.025) },
    uHighTint: { value: new THREE.Vector3(0.03, 0.015, -0.01) },
    uSat: { value: 0.96 },
    uContrast: { value: 1.07 },
    uVig: { value: 0.36 },
    uGrain: { value: 0.03 },
    uCA: { value: 0.0016 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform float uTime, uDamage, uWarp, uSat, uContrast, uVig, uGrain, uCA;
    uniform vec3 uLift, uGain, uShadowTint, uHighTint;
    varying vec2 vUv;
    float ghash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      vec3 col = vec3(texture2D(tDiffuse, uv - c * uCA).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv + c * uCA).b);
      if (uWarp > 0.01) {
        vec3 acc = col;
        for (int i = 1; i <= 4; i++) acc += texture2D(tDiffuse, uv - c * 0.025 * float(i) * uWarp).rgb;
        col = mix(col, acc / 5.0, uWarp) + uWarp * 0.1;
      }
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col += uShadowTint * (1.0 - smoothstep(0.0, 0.5, l)) + uHighTint * smoothstep(0.45, 1.0, l);
      col = col * uGain + uLift * (1.0 - col);
      l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSat);
      col = (col - 0.45) * uContrast + 0.45;
      float v = smoothstep(0.9, 0.25, length(c * vec2(1.0, 0.78)));
      col *= mix(1.0 - uVig, 1.0, v);
      col = mix(col, vec3(0.9, 0.12, 0.08), uDamage * (1.0 - v) * 0.85);
      col += (ghash(uv * uRes + fract(uTime * 7.3) * 91.0) - 0.5) * uGrain;
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};

/** CPU mirror of the terrain vertex stage (height field + curvature) so props sit on the ground. */
export function terrainY(x: number, z: number, scroll: number, curve = 0.0012): number {
  const zs = z - scroll;
  const t = Math.min(1, Math.max(0, (Math.abs(x) - 14) / 44));
  const side = t * t * (3 - 2 * t);
  const roll = 0.5 + 0.5 * Math.sin(zs * 0.045 + x * 0.07) * Math.cos(zs * 0.021 - x * 0.05);
  const r1 = 1 - Math.abs(Math.sin(zs * 0.11 + x * 0.13) * Math.cos(zs * 0.07 - x * 0.09 + 1.3));
  const r2 = 1 - Math.abs(Math.sin(zs * 0.23 - x * 0.19 + 2.1) * Math.cos(zs * 0.17 + x * 0.21));
  const ridge = r1 * r1 * 0.65 + r2 * r2 * 0.35;
  const d = Math.max(0, -z - 30);
  return side * side * (8 + 18 * side) * (0.45 + 0.55 * roll) + side * ridge * 10 + side * 1.2 - d * d * curve;
}

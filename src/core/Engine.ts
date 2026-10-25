import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/examples/jsm/shaders/CopyShader.js';
import { GRADE_SHADER, globalUniforms, type GradeSettings } from '../procgen/Shaders';

export const CAMERA_POS = new THREE.Vector3(0, 3.5, 9.0);
export const CAMERA_TARGET = new THREE.Vector3(0, 1.5, -60.0);
const FOV = 58;
/** Horizon sits at 45% of screen height, measured from the bottom edge (NDC y = -0.1). */
const HORIZON_NDC_Y = -0.1;
const MIN_PIXEL_RATIO = 1.0;
const MAX_PIXEL_RATIO = 1.5;
/** Where the sun's shadow frustum is centred: the stretch of rail where the action happens. */
const SHADOW_FOCUS = new THREE.Vector3(0, 0, -22);

export type UpdateFn = (dt: number, time: number) => void;

/**
 * Owns the WebGL renderer, the fixed-perspective camera, the sun and sky
 * lighting, the post chain (HDR scene → bloom → ACES tone map → film grade)
 * and the RAF / resize loop with adaptive resolution, MSAA and bloom.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** The final grade pass; main drives uDamage on it. */
  readonly post: THREE.ShaderMaterial;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private readonly composer: EffectComposer;
  private readonly scenePass: MsaaRenderPass;
  private readonly bloom: UnrealBloomPass;
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private readonly container: HTMLElement;
  private update: UpdateFn = () => {};
  private last = 0;
  private running = false;
  private elapsed = 0;
  /** Dynamic quality in [0,1]: drives pixel ratio, then MSAA, then bloom. */
  private quality = 1;
  /** Highest quality still allowed; drops just below any level that proved too slow, so it never oscillates. */
  private qualityCeiling = 1;
  private frameAvg = 1 / 60;
  private qualityTimer = 0;
  private fpsEl: HTMLElement | null = null;
  private fpsAcc = 0;
  private fpsFrames = 0;
  timeScale = 1;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // MSAA happens on the HDR scene target instead
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      depth: true,
    });
    this.renderer.setClearColor(0xe2b38a, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 1200);
    this.camera.position.copy(CAMERA_POS);
    this.camera.lookAt(CAMERA_TARGET);

    // Low sun ahead of the camera: every shape gets a hot rim and a long shadow toward the viewer.
    this.sun = new THREE.DirectionalLight(0xffcf98, 3.6);
    this.sun.castShadow = true;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    this.sun.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
    Object.assign(this.sun.shadow.camera, { left: -24, right: 24, top: 34, bottom: -34, near: 1, far: 200 });
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.04;
    this.sun.target.position.copy(SHADOW_FOCUS);
    this.hemi = new THREE.HemisphereLight(0xa7bad6, 0x6a5038, 0.85);
    this.scene.add(this.sun, this.sun.target, this.hemi);
    this.setSunDirection(new THREE.Vector3(0.42, 0.18, -1));

    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
    this.scenePass = new MsaaRenderPass(this.scene, this.camera);
    this.composer.addPass(this.scenePass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.55, 0.88);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    const grade = new ShaderPass(GRADE_SHADER);
    // ShaderPass clones uniforms; re-link the shared time / warp drivers.
    grade.uniforms.uTime = globalUniforms.uTime;
    grade.uniforms.uWarp = globalUniforms.uWarp;
    this.composer.addPass(grade);
    this.post = grade.material;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    if (new URLSearchParams(location.search).has('fps')) {
      this.fpsEl = document.createElement('div');
      this.fpsEl.className = 'fps-meter';
      document.body.appendChild(this.fpsEl);
    }

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 120));
    this.resize();
  }

  /** Points the sun (light and shadows) along `dir`, measured toward the sun. */
  setSunDirection(dir: THREE.Vector3): void {
    this.sun.position.copy(dir).normalize().multiplyScalar(90).add(SHADOW_FOCUS);
  }

  setBloom(strength: number, radius: number, threshold: number): void {
    this.bloom.strength = strength;
    this.bloom.radius = radius;
    this.bloom.threshold = threshold;
  }

  setGrade(g: GradeSettings, exposure: number): void {
    const u = this.post.uniforms;
    (u.uLift.value as THREE.Vector3).set(...g.lift);
    (u.uGain.value as THREE.Vector3).set(...g.gain);
    (u.uShadowTint.value as THREE.Vector3).set(...g.shadowTint);
    (u.uHighTint.value as THREE.Vector3).set(...g.highTint);
    u.uSat.value = g.saturation;
    u.uContrast.value = g.contrast;
    this.renderer.toneMappingExposure = exposure;
  }

  /** Re-captures the sky into the reflection environment used by every PBR surface. */
  updateEnvironment(sky: THREE.Mesh): void {
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(sky.geometry, sky.material));
    const next = this.pmrem.fromScene(envScene, 0.02);
    this.scene.environment = next.texture;
    this.envTarget?.dispose();
    this.envTarget = next;
  }

  private targetPixelRatio(): number {
    const dpr = window.devicePixelRatio || 1;
    const max = Math.min(MAX_PIXEL_RATIO, Math.max(MIN_PIXEL_RATIO, dpr));
    return MIN_PIXEL_RATIO + (max - MIN_PIXEL_RATIO) * this.quality;
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    const pr = this.targetPixelRatio();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    // MSAA on the scene target and bloom only while the device keeps up.
    const samples = this.quality >= 0.75 ? 4 : 0;
    this.scenePass.setSamples(samples);
    this.bloom.enabled = this.quality >= 0.5;
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    (this.post.uniforms.uRes.value as THREE.Vector2).set(w * pr, h * pr);
    this.camera.aspect = w / h;
    this.updateProjection();
  }

  /** Rebuilds the projection and shifts it so the horizon lands at 45% screen height. */
  updateProjection(): void {
    const cam = this.camera;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const far = new THREE.Vector3(cam.position.x, cam.position.y, cam.position.z - 1e5).project(cam);
    const shift = HORIZON_NDC_Y - far.y;
    cam.projectionMatrix.elements[9] -= shift;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }

  start(update: UpdateFn): void {
    this.update = update;
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      // The first RAF timestamp can predate `last`; never feed a negative step.
      const rawDt = Math.min(Math.max(0, (now - this.last) / 1000), 0.25);
      this.last = now;
      this.trackPerformance(rawDt);
      // Clamp to keep the damping term (1 - gamma*dt) positive and stable.
      const dt = Math.min(rawDt, 1 / 30) * this.timeScale;
      this.elapsed += dt;
      globalUniforms.uTime.value = this.elapsed;
      this.update(dt, this.elapsed);
      this.render(dt);
    };
    requestAnimationFrame(loop);
  }

  private trackPerformance(dt: number): void {
    // Hitches (tab switches, GC, the resize itself) must not count as sustained slowness.
    if (dt < 0.1) this.frameAvg += (dt - this.frameAvg) * 0.05;
    this.qualityTimer += dt;
    if (this.qualityTimer > 2) {
      this.qualityTimer = 0;
      const prev = this.quality;
      if (this.frameAvg > 1 / 50) {
        this.qualityCeiling = Math.max(0, this.quality - 0.05);
        this.quality = Math.max(0, this.quality - 0.25);
      } else if (this.frameAvg < 1 / 58) {
        this.quality = Math.min(this.qualityCeiling, this.quality + 0.1);
      }
      // Toggling bloom / MSAA / resolution reads as a flash, so only step when it changes things.
      if (prev !== this.quality) {
        this.resize();
        this.frameAvg = 1 / 60;
      }
    }
    if (this.fpsEl) {
      this.fpsAcc += dt;
      this.fpsFrames++;
      if (this.fpsAcc >= 0.5) {
        this.fpsEl.textContent = `${Math.round(this.fpsFrames / this.fpsAcc)} fps · pr ${this.renderer
          .getPixelRatio()
          .toFixed(2)} · q ${this.quality.toFixed(2)} · calls ${this.renderer.info.render.calls}`;
        this.fpsAcc = 0;
        this.fpsFrames = 0;
      }
    }
  }

  private render(dt: number): void {
    this.renderer.info.reset();
    this.composer.render(dt);
  }
}

/**
 * Renders the scene into its own multisampled HDR target, then copies it into
 * the composer's read buffer. Keeping MSAA out of the composer's ping-pong
 * buffers matters: a multisampled target drawn into twice in one frame (scene,
 * then bloom or output) intermittently resolves to black on Chrome / Android.
 */
class MsaaRenderPass extends Pass {
  private readonly target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  private readonly copy = new FullScreenQuad(
    new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: CopyShader.vertexShader,
      // MSAA can shade samples just outside a triangle, where some materials produce NaN/Inf.
      // Invisible on its own, but bloom's blur smears one such pixel into a black block.
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          bvec4 bad = bvec4(isnan(c.r) || isinf(c.r), isnan(c.g) || isinf(c.g), isnan(c.b) || isinf(c.b), false);
          c.rgb = any(bad) ? vec3(0.0) : clamp(c.rgb, 0.0, 64.0);
          gl_FragColor = vec4(c.rgb, 1.0);
        }`,
    }),
  );

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
  ) {
    super();
    this.needsSwap = false;
    (this.copy.material as THREE.ShaderMaterial).uniforms.tDiffuse.value = this.target.texture;
  }

  setSamples(samples: number): void {
    if (this.target.samples === samples) return;
    this.target.samples = samples;
    this.target.dispose();
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height);
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(read);
    this.copy.render(renderer);
  }
}

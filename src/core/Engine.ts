import * as THREE from 'three';
import { createGradeMaterial, globalUniforms } from '../procgen/Shaders';

export const CAMERA_POS = new THREE.Vector3(0, 3.5, 9.0);
export const CAMERA_TARGET = new THREE.Vector3(0, 1.5, -60.0);
const FOV = 58;
/** Horizon sits at 45% of screen height, measured from the bottom edge (NDC y = -0.1). */
const HORIZON_NDC_Y = -0.1;
const MIN_PIXEL_RATIO = 1.0;
const MAX_PIXEL_RATIO = 1.5;

export type UpdateFn = (dt: number, time: number) => void;

/**
 * Owns the WebGL renderer, the fixed-perspective camera, the low-res scene
 * render target and the CRT composite pass, plus the RAF / resize loop.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly post: THREE.ShaderMaterial;
  private readonly rt: THREE.WebGLRenderTarget;
  private readonly postScene = new THREE.Scene();
  private readonly postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly container: HTMLElement;
  private update: UpdateFn = () => {};
  private last = 0;
  private running = false;
  private elapsed = 0;
  /** Dynamic resolution: quality in [0,1] maps into the clamped pixel-ratio range. */
  private quality = 1;
  private frameAvg = 1 / 60;
  private qualityTimer = 0;
  private fpsEl: HTMLElement | null = null;
  private fpsAcc = 0;
  private fpsFrames = 0;
  timeScale = 1;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // MSAA happens on the scene render target instead
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      depth: true,
    });
    this.renderer.setClearColor(0xcdeeff, 1);
    this.renderer.autoClear = true;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.1, 900);
    this.camera.position.copy(CAMERA_POS);
    this.camera.lookAt(CAMERA_TARGET);

    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      samples: 4,
    });
    this.post = createGradeMaterial();
    this.post.uniforms.tDiffuse.value = this.rt.texture;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post);
    quad.frustumCulled = false;
    this.postScene.add(quad);

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
    // MSAA on the scene target only while the device keeps up.
    const samples = this.quality >= 0.75 ? 4 : 0;
    if (this.rt.samples !== samples) {
      this.rt.samples = samples;
      this.rt.dispose();
    }
    const bw = Math.floor(w * pr);
    const bh = Math.floor(h * pr);
    this.rt.setSize(bw, bh);
    (this.post.uniforms.uRes.value as THREE.Vector2).set(bw, bh);
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
      const rawDt = Math.min((now - this.last) / 1000, 0.25);
      this.last = now;
      this.trackPerformance(rawDt);
      // Clamp to keep the damping term (1 - gamma*dt) positive and stable.
      const dt = Math.min(rawDt, 1 / 30) * this.timeScale;
      this.elapsed += dt;
      globalUniforms.uTime.value = this.elapsed;
      this.update(dt, this.elapsed);
      this.render();
    };
    requestAnimationFrame(loop);
  }

  private trackPerformance(dt: number): void {
    this.frameAvg += (dt - this.frameAvg) * 0.05;
    this.qualityTimer += dt;
    if (this.qualityTimer > 1.5) {
      this.qualityTimer = 0;
      const prev = this.quality;
      if (this.frameAvg > 1 / 52) this.quality = Math.max(0, this.quality - 0.25);
      else if (this.frameAvg < 1 / 58 && this.quality < 1) this.quality = Math.min(1, this.quality + 0.1);
      if (prev !== this.quality) this.resize();
    }
    if (this.fpsEl) {
      this.fpsAcc += dt;
      this.fpsFrames++;
      if (this.fpsAcc >= 0.5) {
        this.fpsEl.textContent = `${Math.round(this.fpsFrames / this.fpsAcc)} fps · pr ${this.renderer
          .getPixelRatio()
          .toFixed(2)} · calls ${this.renderer.info.render.calls}`;
        this.fpsAcc = 0;
        this.fpsFrames = 0;
      }
    }
  }

  private render(): void {
    this.renderer.info.reset();
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.postCam);
  }
}

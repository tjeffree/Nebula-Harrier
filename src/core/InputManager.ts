export type NavAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back';

const DEADZONE = 0.18;
const STICK_RADIUS = 60;
const DOUBLE_TAP_MS = 300;
const DASH_ARM_MS = 260;

/**
 * Unifies keyboard/mouse, touch (virtual analog stick + floating fire button)
 * and the standard Gamepad API into one normalised control state.
 */
export class InputManager {
  /** Normalised movement in [-1,1]. +y is up. */
  moveX = 0;
  moveY = 0;
  fire = false;
  /** Enables arrow/gamepad navigation events for DOM menus. */
  menuMode = true;
  readonly isTouch: boolean;

  private keys = new Set<string>();
  private mouseFire = false;
  private touchFire = false;
  private padFire = false;
  private dashQueued: { x: number; y: number } | null = null;
  private secondaryQueued = false;
  private meleeQueued = false;
  private pauseQueued = false;
  private navQueue: NavAction[] = [];
  private lastDir = { x: 1, y: 0 };

  // Touch stick state.
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private stickVec = { x: 0, y: 0 };
  private lastStickTap = 0;
  private dashArmedUntil = 0;
  private fireId: number | null = null;
  private stickBase!: HTMLDivElement;
  private stickKnob!: HTMLDivElement;
  private fireBtn!: HTMLDivElement;
  private altBtn!: HTMLDivElement;
  private altLabel!: HTMLSpanElement;
  private altState = { fill: -1, label: '' };
  private whipBtn!: HTMLDivElement;
  private whipFill = -1;
  private touchLayer!: HTMLDivElement;

  // Gamepad edge detection.
  private padPrev: boolean[] = [];
  private padAxisLatch = { x: 0, y: 0 };

  constructor(private readonly surface: HTMLElement) {
    this.isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseFire = false;
    });
    surface.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.mouseFire = true;
      if (e.button === 2) this.secondaryQueued = true;
      if (e.button === 1) {
        e.preventDefault();
        this.meleeQueued = true;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseFire = false;
    });
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
    this.buildTouchControls();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const code = e.code;
    if (down) {
      if (!this.keys.has(code)) {
        if (code === 'ShiftLeft' || code === 'ShiftRight') this.queueDashFromMove();
        if (code === 'KeyE' || code === 'KeyX') this.secondaryQueued = true;
        if (code === 'KeyQ' || code === 'KeyF' || code === 'KeyC') this.meleeQueued = true;
        if (code === 'Escape' || code === 'KeyP') this.pauseQueued = true;
        if (this.menuMode) {
          const nav: Record<string, NavAction> = {
            ArrowUp: 'up',
            ArrowDown: 'down',
            ArrowLeft: 'left',
            ArrowRight: 'right',
            KeyW: 'up',
            KeyS: 'down',
            KeyA: 'left',
            KeyD: 'right',
          };
          if (nav[code]) this.navQueue.push(nav[code]);
        }
      }
      this.keys.add(code);
      if (!this.menuMode && (code === 'Space' || code.startsWith('Arrow'))) e.preventDefault();
    } else {
      this.keys.delete(code);
    }
  }

  private queueDashFromMove(): void {
    const kx = this.keyAxisX();
    const ky = this.keyAxisY();
    const x = kx !== 0 || ky !== 0 ? kx : this.lastDir.x;
    const y = kx !== 0 || ky !== 0 ? ky : this.lastDir.y;
    const len = Math.hypot(x, y) || 1;
    this.dashQueued = { x: x / len, y: y / len };
  }

  private keyAxisX(): number {
    const k = this.keys;
    return (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
  }

  private keyAxisY(): number {
    const k = this.keys;
    return (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
  }

  // -------------------------------------------------------------------------
  // Touch: left half = floating virtual analog stick, right = fire button.
  // Double-tap on the stick then push a direction to dash.
  // -------------------------------------------------------------------------
  private buildTouchControls(): void {
    const layer = document.createElement('div');
    layer.className = 'touch-layer';
    layer.innerHTML = `
      <div class="stick-zone"></div>
      <div class="stick-base"><div class="stick-knob"></div></div>
      <div class="fire-btn"><span>FIRE</span></div>
      <div class="alt-btn empty"><span></span></div>
      <div class="alt-btn whip-btn ready"><span>WHIP</span></div>`;
    this.surface.parentElement!.appendChild(layer);
    this.touchLayer = layer;
    this.stickBase = layer.querySelector('.stick-base') as HTMLDivElement;
    this.stickKnob = layer.querySelector('.stick-knob') as HTMLDivElement;
    this.fireBtn = layer.querySelector('.fire-btn') as HTMLDivElement;
    const zone = layer.querySelector('.stick-zone') as HTMLDivElement;

    const opts: AddEventListenerOptions = { passive: false };
    zone.addEventListener('touchstart', (e) => this.onStickStart(e), opts);
    zone.addEventListener('touchmove', (e) => this.onStickMove(e), opts);
    zone.addEventListener('touchend', (e) => this.onStickEnd(e), opts);
    zone.addEventListener('touchcancel', (e) => this.onStickEnd(e), opts);

    this.fireBtn.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        const t = e.changedTouches[0];
        this.fireId = t.identifier;
        this.touchFire = true;
        this.fireBtn.classList.add('active');
      },
      opts,
    );
    const endFire = (e: TouchEvent) => {
      e.preventDefault();
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.fireId) {
          this.fireId = null;
          this.touchFire = false;
          this.fireBtn.classList.remove('active');
        }
      }
    };
    this.fireBtn.addEventListener('touchend', endFire, opts);
    this.fireBtn.addEventListener('touchcancel', endFire, opts);

    this.whipBtn = layer.querySelector('.whip-btn') as HTMLDivElement;
    this.whipBtn.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        this.meleeQueued = true;
      },
      opts,
    );
    this.altBtn = layer.querySelector('.alt-btn:not(.whip-btn)') as HTMLDivElement;
    this.altLabel = this.altBtn.querySelector('span') as HTMLSpanElement;
    this.altBtn.addEventListener(
      'touchstart',
      (e) => {
        e.preventDefault();
        this.secondaryQueued = true;
      },
      opts,
    );
    this.setTouchVisible(false);
  }

  setTouchVisible(v: boolean): void {
    this.touchLayer.style.display = v && this.isTouch ? 'block' : 'none';
  }

  /** Secondary button: `fill` 0..1 sweeps round as it recharges; an empty label means nothing equipped. */
  setSecondaryButton(fill: number, label: string): void {
    const f = Math.round(fill * 50) / 50;
    if (f === this.altState.fill && label === this.altState.label) return;
    this.altState = { fill: f, label };
    this.altBtn.style.setProperty('--fill', String(f));
    this.altBtn.classList.toggle('empty', !label);
    this.altBtn.classList.toggle('ready', !!label && f >= 1);
    this.altLabel.textContent = label;
  }

  /** Whip button: `fill` 0..1 sweeps round as the whip recharges. */
  setMeleeButton(fill: number): void {
    const f = Math.round(fill * 50) / 50;
    if (f === this.whipFill) return;
    this.whipFill = f;
    this.whipBtn.style.setProperty('--fill', String(f));
    this.whipBtn.classList.toggle('ready', f >= 1);
  }

  private onStickStart(e: TouchEvent): void {
    e.preventDefault();
    if (this.stickId !== null) return;
    const t = e.changedTouches[0];
    this.stickId = t.identifier;
    this.stickOrigin = { x: t.clientX, y: t.clientY };
    this.stickVec = { x: 0, y: 0 };
    this.stickBase.style.display = 'block';
    this.stickBase.style.transform = `translate(${t.clientX - STICK_RADIUS}px, ${t.clientY - STICK_RADIUS}px)`;
    this.stickKnob.style.transform = 'translate(0px, 0px)';
    const now = performance.now();
    if (now - this.lastStickTap < DOUBLE_TAP_MS) {
      this.dashArmedUntil = now + DASH_ARM_MS;
      this.lastStickTap = 0;
    } else {
      this.lastStickTap = now;
    }
  }

  private onStickMove(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== this.stickId) continue;
      let dx = t.clientX - this.stickOrigin.x;
      let dy = t.clientY - this.stickOrigin.y;
      const len = Math.hypot(dx, dy);
      if (len > STICK_RADIUS) {
        dx = (dx / len) * STICK_RADIUS;
        dy = (dy / len) * STICK_RADIUS;
      }
      this.stickVec = { x: dx / STICK_RADIUS, y: -dy / STICK_RADIUS };
      this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  }

  private onStickEnd(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier !== this.stickId) continue;
      this.stickId = null;
      this.stickVec = { x: 0, y: 0 };
      this.stickBase.style.display = 'none';
    }
  }

  // -------------------------------------------------------------------------

  /** Poll once per frame before reading state. */
  update(): void {
    let mx = this.keyAxisX();
    let my = this.keyAxisY();
    let padFire = false;

    // Touch stick.
    if (this.stickId !== null) {
      const m = Math.hypot(this.stickVec.x, this.stickVec.y);
      if (m > DEADZONE) {
        mx += this.stickVec.x;
        my += this.stickVec.y;
      }
    }
    if (this.dashArmedUntil > 0) {
      const now = performance.now();
      const m = Math.hypot(this.stickVec.x, this.stickVec.y);
      if (m > 0.35) {
        this.dashQueued = { x: this.stickVec.x / m, y: this.stickVec.y / m };
        this.dashArmedUntil = 0;
      } else if (now > this.dashArmedUntil) {
        this.dashQueued = { ...this.lastDir };
        this.dashArmedUntil = 0;
      }
    }

    // Gamepads.
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const ax = pad.axes[0] ?? 0;
      const ay = pad.axes[1] ?? 0;
      const am = Math.hypot(ax, ay);
      if (am > DEADZONE) {
        mx += ax;
        my -= ay;
      }
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      const edge = (i: number) => b(i) && !this.padPrev[i];
      if (b(12)) my += 1;
      if (b(13)) my -= 1;
      if (b(14)) mx -= 1;
      if (b(15)) mx += 1;
      padFire = b(7) || b(0) || (pad.buttons[7]?.value ?? 0) > 0.3;
      if (edge(5) || edge(2)) this.secondaryQueued = true;
      if (!this.menuMode && (edge(1) || edge(6) || edge(3))) this.meleeQueued = true;
      if (edge(4)) {
        const len = Math.hypot(mx, my);
        this.dashQueued = len > 0.2 ? { x: mx / len, y: my / len } : { ...this.lastDir };
      }
      if (edge(9)) this.pauseQueued = true;
      if (this.menuMode) {
        if (edge(12)) this.navQueue.push('up');
        if (edge(13)) this.navQueue.push('down');
        if (edge(14)) this.navQueue.push('left');
        if (edge(15)) this.navQueue.push('right');
        if (edge(0)) this.navQueue.push('confirm');
        if (edge(1)) this.navQueue.push('back');
        // Stick-to-nav with latch so one push = one step.
        const sx = Math.abs(ax) > 0.6 ? Math.sign(ax) : 0;
        const sy = Math.abs(ay) > 0.6 ? Math.sign(ay) : 0;
        if (sx !== this.padAxisLatch.x && sx !== 0) this.navQueue.push(sx > 0 ? 'right' : 'left');
        if (sy !== this.padAxisLatch.y && sy !== 0) this.navQueue.push(sy > 0 ? 'down' : 'up');
        this.padAxisLatch = { x: sx, y: sy };
      }
      this.padPrev = pad.buttons.map((x) => x.pressed);
      break;
    }

    const len = Math.hypot(mx, my);
    if (len > 1) {
      mx /= len;
      my /= len;
    }
    this.moveX = mx;
    this.moveY = my;
    if (len > 0.3) this.lastDir = { x: mx / Math.max(len, 1e-6), y: my / Math.max(len, 1e-6) };
    this.padFire = padFire;
    this.fire = this.keys.has('Space') || this.mouseFire || this.touchFire || this.padFire;
  }

  consumeDash(): { x: number; y: number } | null {
    const d = this.dashQueued;
    this.dashQueued = null;
    return d;
  }

  consumeSecondary(): boolean {
    const s = this.secondaryQueued;
    this.secondaryQueued = false;
    return s;
  }

  consumeMelee(): boolean {
    const m = this.meleeQueued;
    this.meleeQueued = false;
    return m;
  }

  consumePause(): boolean {
    const p = this.pauseQueued;
    this.pauseQueued = false;
    return p;
  }

  requestPause(): void {
    this.pauseQueued = true;
  }

  consumeNav(): NavAction | undefined {
    return this.navQueue.shift();
  }

  /** Drops any input latched while a menu was open so it doesn't leak into play. */
  flush(): void {
    this.dashQueued = null;
    this.secondaryQueued = false;
    this.meleeQueued = false;
    this.pauseQueued = false;
    this.navQueue.length = 0;
    this.mouseFire = false;
  }
}

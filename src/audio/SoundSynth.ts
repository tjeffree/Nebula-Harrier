/**
 * All sound effects are synthesised from oscillator / noise / biquad / gain
 * graphs on a single shared AudioContext. No decoded audio files.
 */
export class SoundSynth {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly sfxBus: GainNode;
  readonly musicBus: GainNode;
  private readonly white: AudioBuffer;
  private readonly pink: AudioBuffer;
  private readonly last = new Map<string, number>();
  private engine: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 5;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.sfxBus = this.ctx.createGain();
    this.musicBus = this.ctx.createGain();
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    this.white = this.makeWhite(1.5);
    this.pink = this.makePink(3);
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Must be called from a user gesture on iOS / Chrome autoplay policies. */
  unlock(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  suspend(): void {
    if (this.ctx.state === 'running') void this.ctx.suspend();
  }

  setVolumes(music: number, sfx: number): void {
    this.musicBus.gain.setTargetAtTime(music, this.now, 0.05);
    this.sfxBus.gain.setTargetAtTime(sfx, this.now, 0.05);
  }

  noiseBuffer(): AudioBuffer {
    return this.white;
  }

  private makeWhite(seconds: number): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Paul Kellet's refined pink-noise filter. */
  private makePink(seconds: number): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0,
      b1 = 0,
      b2 = 0,
      b3 = 0,
      b4 = 0,
      b5 = 0,
      b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return buf;
  }

  /** Rate-limits a voice so dense fire doesn't stack hundreds of nodes. */
  private gate(key: string, minGap: number): boolean {
    const t = this.now;
    if (t - (this.last.get(key) ?? -1) < minGap) return false;
    this.last.set(key, t);
    return true;
  }

  private get live(): boolean {
    return this.ctx.state === 'running';
  }

  // -------------------------------------------------------------------------
  // SFX
  // -------------------------------------------------------------------------

  /** Core laser: sawtooth 880→110 Hz exponential sweep over 0.18s. */
  laser(pitch = 1): void {
    if (!this.live || !this.gate('laser', 0.06)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(880 * pitch, t);
    osc.frequency.exponentialRampToValueAtTime(110 * pitch, t + 0.18);
    gain.gain.setValueAtTime(0.09, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(gain);
    gain.connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  enemyShot(vol = 1): void {
    if (!this.live || !this.gate('eshot', 0.08)) return;
    const t = this.now;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(320, t);
    osc.frequency.exponentialRampToValueAtTime(640, t + 0.08);
    g.gain.setValueAtTime(0.05 * vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + 0.13);
  }

  hit(): void {
    if (!this.live || !this.gate('hit', 0.04)) return;
    const t = this.now;
    const src = this.ctx.createBufferSource();
    src.buffer = this.white;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2400;
    f.Q.value = 2;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start(t, Math.random());
    src.stop(t + 0.07);
  }

  /** White noise through a rapid low-pass sweep to 40 Hz, non-linear release. */
  explosion(size = 1): void {
    if (!this.live || !this.gate('boom', 0.05)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.45 + size * 0.5;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    src.playbackRate.value = 0.7 + Math.random() * 0.3;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(3200 + size * 1500, t);
    lp.frequency.exponentialRampToValueAtTime(40, t + dur * 0.8);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.45 * Math.min(1.5, 0.5 + size * 0.5), t + 0.008);
    // Non-linear (convex) release: fast drop then long tail.
    g.gain.setTargetAtTime(0.0001, t + 0.02, dur / 5);
    // Sub thump.
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(110, t);
    sub.frequency.exponentialRampToValueAtTime(30, t + 0.3);
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.35 * Math.min(1.5, size), t);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(lp).connect(g).connect(this.sfxBus);
    sub.connect(sg).connect(this.sfxBus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur);
    sub.start(t);
    sub.stop(t + 0.36);
  }

  playerHit(): void {
    if (!this.live) return;
    const t = this.now;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.35);
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1200;
    o.connect(f).connect(g).connect(this.sfxBus);
    o.start(t);
    o.stop(t + 0.41);
    this.explosion(0.4);
  }

  shieldBreak(): void {
    if (!this.live) return;
    const t = this.now;
    for (const [fr, d] of [
      [1760, 0],
      [1318, 0.05],
      [880, 0.1],
    ]) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = fr;
      g.gain.setValueAtTime(0.12, t + d);
      g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.25);
      o.connect(g).connect(this.sfxBus);
      o.start(t + d);
      o.stop(t + d + 0.26);
    }
  }

  dash(): void {
    if (!this.live) return;
    const t = this.now;
    const src = this.ctx.createBufferSource();
    src.buffer = this.white;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 4;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(4000, t + 0.2);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 0.26);
  }

  chain(): void {
    if (!this.live || !this.gate('chain', 0.07)) return;
    const t = this.now;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(1800, t);
    for (let i = 1; i < 6; i++) o.frequency.setValueAtTime(600 + Math.random() * 2400, t + i * 0.012);
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(g).connect(this.sfxBus);
    o.start(t);
    o.stop(t + 0.09);
  }

  /** Refusal buzz: locked purchase, ordnance not ready. */
  deny(): void {
    if (!this.live) return;
    const t = this.now;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime(140, t);
    o.frequency.setValueAtTime(110, t + 0.12);
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.sfxBus);
    o.start(t);
    o.stop(t + 0.31);
  }

  /** UI blip; `up` selects an ascending vs. neutral contour. */
  click(up = false): void {
    if (!this.live) return;
    const t = this.now;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(up ? 660 : 520, t);
    if (up) o.frequency.exponentialRampToValueAtTime(1320, t + 0.08);
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(g).connect(this.sfxBus);
    o.start(t);
    o.stop(t + 0.11);
  }

  boon(): void {
    if (!this.live) return;
    const t = this.now;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      const s = t + i * 0.06;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.1, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, s + 0.4);
      o.connect(lp).connect(g).connect(this.sfxBus);
      o.start(s);
      o.stop(s + 0.41);
    });
  }

  alarm(): void {
    if (!this.live) return;
    const t = this.now;
    for (let i = 0; i < 4; i++) {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'square';
      const s = t + i * 0.42;
      o.frequency.setValueAtTime(880, s);
      o.frequency.linearRampToValueAtTime(440, s + 0.36);
      g.gain.setValueAtTime(0.09, s);
      g.gain.linearRampToValueAtTime(0.0001, s + 0.38);
      o.connect(g).connect(this.sfxBus);
      o.start(s);
      o.stop(s + 0.4);
    }
  }

  warp(): void {
    if (!this.live) return;
    const t = this.now;
    const src = this.ctx.createBufferSource();
    src.buffer = this.pink;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(120, t);
    f.frequency.exponentialRampToValueAtTime(5000, t + 2.2);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.6, t + 1.6);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.6);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + 2.7);
  }

  // -------------------------------------------------------------------------
  // Engine hum: looping pink noise through a resonant band-pass whose centre
  // frequency tracks player speed.
  // -------------------------------------------------------------------------
  startEngine(): void {
    if (this.engine) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.pink;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 9;
    filter.frequency.value = 180;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.sfxBus);
    src.start();
    this.engine = { src, filter, gain };
  }

  /** speed in world units/s of the player; rail = forward scroll speed. */
  setEngine(speed: number, rail: number, active: boolean): void {
    if (!this.engine) return;
    const t = this.now;
    const f = 140 + rail * 2.5 + speed * 45;
    this.engine.filter.frequency.setTargetAtTime(f, t, 0.08);
    this.engine.gain.gain.setTargetAtTime(active ? 0.22 + Math.min(0.2, speed * 0.02) : 0, t, 0.15);
  }
}

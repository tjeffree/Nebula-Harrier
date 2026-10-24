import { mulberry32 } from '../procgen/SectorBuilder';
import type { SoundSynth } from './SoundSynth';

export type MusicMode = 'off' | 'title' | 'run' | 'boss';

const BPM = 138;
const STEP = 60 / BPM / 4; // 16th note
const LOOKAHEAD = 0.12;
const TICK_MS = 25;

const SCALES: number[][] = [
  [0, 2, 3, 5, 7, 8, 10], // aeolian
  [0, 1, 3, 5, 7, 8, 10], // phrygian
  [0, 2, 3, 5, 7, 9, 10], // dorian
  [0, 2, 3, 5, 7, 8, 11], // harmonic minor
];
// Progressions as scale-degree roots (i–VI–III–VII etc).
const PROGRESSIONS: number[][] = [
  [0, 5, 2, 6],
  [0, 3, 5, 4],
  [0, 6, 5, 6],
  [0, 5, 3, 4],
];

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

interface Song {
  root: number;
  scale: number[];
  prog: number[];
  bass: (number | null)[]; // 16-step offsets relative to chord root (semitones)
  bassAccent: boolean[];
  arpOrder: number[];
  hook: (number | null)[]; // 32 steps, scale degrees
}

/**
 * Algorithmic synthwave: 16-step bassline buffers, chord-tone arpeggiator and
 * a resonant FM lead hook, all scheduled ahead on the audio clock at 138 BPM.
 */
export class MusicTrackGen {
  private mode: MusicMode = 'off';
  private song: Song;
  private step = 0;
  private nextTime = 0;
  private timer: number | null = null;

  constructor(private readonly synth: SoundSynth) {
    this.song = this.compose(1);
  }

  setSeed(seed: number): void {
    this.song = this.compose(seed);
  }

  setMode(mode: MusicMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'off') {
      if (this.timer !== null) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    if (this.timer === null) {
      this.step = 0;
      this.nextTime = this.synth.now + 0.08;
      this.timer = window.setInterval(() => this.tick(), TICK_MS);
    }
  }

  private compose(seed: number): Song {
    const r = mulberry32(seed * 2654435761);
    const pick = <T>(a: T[]): T => a[Math.floor(r() * a.length)];
    const scale = pick(SCALES);
    const root = 33 + Math.floor(r() * 7); // A1..D#2
    // Bassline: driving offbeat/octave patterns with occasional fifths.
    const bass: (number | null)[] = [];
    const bassAccent: boolean[] = [];
    for (let i = 0; i < 16; i++) {
      const on = i % 2 === 1 || i % 4 === 0 || r() < 0.3;
      const v = r();
      bass.push(on ? (v < 0.6 ? 0 : v < 0.85 ? 12 : 7) : null);
      bassAccent.push(i % 4 === 2 || r() < 0.15);
    }
    const arpOrder = pick([
      [0, 1, 2, 3],
      [0, 2, 1, 3],
      [0, 1, 2, 1, 3, 2],
      [3, 2, 1, 0],
    ]);
    // Lead hook: two-bar call/response motif in scale degrees.
    const hook: (number | null)[] = [];
    const motif: (number | null)[] = [];
    let deg = 4 + Math.floor(r() * 3);
    for (let i = 0; i < 16; i++) {
      if (r() < (i % 4 === 0 ? 0.85 : i % 2 === 0 ? 0.45 : 0.18)) {
        deg += Math.floor(r() * 5) - 2;
        deg = Math.max(0, Math.min(11, deg));
        motif.push(deg);
      } else motif.push(null);
    }
    for (let i = 0; i < 16; i++) hook.push(motif[i]);
    for (let i = 0; i < 16; i++) hook.push(i < 12 ? motif[i] : motif[i] === null ? null : (motif[i] as number) - 2);
    return { root, scale, prog: pick(PROGRESSIONS), bass, bassAccent, arpOrder, hook };
  }

  private degreeToMidi(deg: number, base: number): number {
    const s = this.song.scale;
    const oct = Math.floor(deg / s.length);
    return base + s[((deg % s.length) + s.length) % s.length] + oct * 12;
  }

  private tick(): void {
    const ctx = this.synth.ctx;
    if (ctx.state !== 'running') {
      this.nextTime = ctx.currentTime + 0.05;
      return;
    }
    // Recover if the tab was throttled and we fell far behind.
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.02;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      this.schedule(this.step, this.nextTime);
      this.nextTime += STEP;
      this.step++;
    }
  }

  private schedule(step: number, t: number): void {
    const s = this.song;
    const mode = this.mode;
    const i16 = step % 16;
    const bar = Math.floor(step / 16);
    const chordDeg = s.prog[bar % s.prog.length];
    const chordRoot = this.degreeToMidi(chordDeg, s.root);
    const phrase = Math.floor(bar / 4);

    const drums = mode === 'run' || mode === 'boss';
    if (drums) {
      if (i16 % 4 === 0) this.kick(t);
      if (i16 === 4 || i16 === 12) this.snare(t);
      if (mode === 'boss' ? true : i16 % 2 === 1) this.hat(t, i16 % 4 === 2 ? 0.05 : 0.03);
      if (mode === 'boss' && i16 === 14) this.snare(t, 0.5);
    }

    // Bass.
    const b = s.bass[i16];
    if (b !== null && mode !== 'title') {
      this.fmBass(t, mtof(chordRoot + b), s.bassAccent[i16]);
    } else if (mode === 'title' && i16 % 8 === 0) {
      this.pad(t, chordDeg);
    }

    // Arpeggiator over chord tones (1-3-5-7), lifted an octave in boss mode.
    const tones = [0, 2, 4, 6].map((d) => this.degreeToMidi(chordDeg + d, s.root + 24));
    const arpNote = tones[s.arpOrder[step % s.arpOrder.length] % 4] + (mode === 'boss' ? 12 : 0);
    const arpOn = mode === 'title' ? i16 % 2 === 0 : true;
    if (arpOn) this.arp(t, mtof(arpNote), step);

    // Lead hook on alternating phrases (always during boss).
    if (mode === 'run' ? phrase % 2 === 1 : mode === 'boss') {
      const h = s.hook[step % 32];
      if (h !== null) this.lead(t, mtof(this.degreeToMidi(h, s.root + 36)), mode === 'boss');
    }
  }

  // -------------------------------------------------------------------------
  // Voices
  // -------------------------------------------------------------------------
  private out(): AudioNode {
    return this.synth.musicBus;
  }

  /** Two-operator FM bass: modulator → carrier frequency. */
  private fmBass(t: number, f: number, accent: boolean): void {
    const ctx = this.synth.ctx;
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    car.type = 'sawtooth';
    mod.type = 'sine';
    car.frequency.value = f;
    mod.frequency.value = f * 2;
    modGain.gain.setValueAtTime(f * (accent ? 3 : 1.6), t);
    modGain.gain.exponentialRampToValueAtTime(f * 0.2, t + 0.12);
    lp.type = 'lowpass';
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(accent ? 1800 : 900, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.14);
    const dur = STEP * 0.95;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(accent ? 0.32 : 0.24, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    mod.connect(modGain).connect(car.frequency);
    car.connect(lp).connect(g).connect(this.out());
    car.start(t);
    mod.start(t);
    car.stop(t + dur + 0.01);
    mod.stop(t + dur + 0.01);
  }

  private arp(t: number, f: number, step: number): void {
    const ctx = this.synth.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    o.type = 'square';
    o.frequency.value = f;
    lp.type = 'lowpass';
    lp.Q.value = 10;
    // Slow cutoff LFO across 4 bars for movement.
    const sweep = 900 + 1700 * (0.5 + 0.5 * Math.sin((step / 64) * Math.PI * 2));
    lp.frequency.setValueAtTime(sweep, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.1);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, t + STEP * 0.9);
    o.connect(lp).connect(g).connect(this.out());
    o.start(t);
    o.stop(t + STEP);
  }

  /** Resonant FM lead with slight detune. */
  private lead(t: number, f: number, hot: boolean): void {
    const ctx = this.synth.ctx;
    const car = ctx.createOscillator();
    const car2 = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const mg = ctx.createGain();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    car.type = 'sawtooth';
    car2.type = 'sawtooth';
    car.frequency.value = f;
    car2.frequency.value = f * 1.006;
    mod.frequency.value = f * 3;
    mg.gain.value = f * (hot ? 1.2 : 0.6);
    lp.type = 'lowpass';
    lp.Q.value = 12;
    lp.frequency.setValueAtTime(3200, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.22);
    const dur = STEP * 1.8;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    mod.connect(mg);
    mg.connect(car.frequency);
    mg.connect(car2.frequency);
    car.connect(lp);
    car2.connect(lp);
    lp.connect(g).connect(this.out());
    for (const o of [car, car2, mod]) {
      o.start(t);
      o.stop(t + dur + 0.02);
    }
  }

  private pad(t: number, chordDeg: number): void {
    const ctx = this.synth.ctx;
    const dur = STEP * 8;
    for (const d of [0, 2, 4]) {
      const m = this.degreeToMidi(chordDeg + d, this.song.root + 24);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const lp = ctx.createBiquadFilter();
      o.type = 'sawtooth';
      o.frequency.value = mtof(m);
      o.detune.value = (Math.random() - 0.5) * 14;
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.035, t + 0.3);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(lp).connect(g).connect(this.out());
      o.start(t);
      o.stop(t + dur + 0.02);
    }
  }

  private kick(t: number): void {
    const ctx = this.synth.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    o.connect(g).connect(this.out());
    o.start(t);
    o.stop(t + 0.3);
  }

  private snare(t: number, vol = 1): void {
    const ctx = this.synth.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.synth.noiseBuffer();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22 * vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(hp).connect(g).connect(this.out());
    src.start(t, Math.random());
    src.stop(t + 0.17);
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(240, t);
    o.frequency.exponentialRampToValueAtTime(140, t + 0.06);
    og.gain.setValueAtTime(0.18 * vol, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(og).connect(this.out());
    o.start(t);
    o.stop(t + 0.09);
  }

  private hat(t: number, vol: number): void {
    const ctx = this.synth.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.synth.noiseBuffer();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    src.connect(hp).connect(g).connect(this.out());
    src.start(t, Math.random());
    src.stop(t + 0.05);
  }
}

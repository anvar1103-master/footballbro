/**
 * All sound is synthesised with WebAudio (no audio files): kicks, bounces, net swish,
 * post "clang", referee whistle and a reactive crowd.
 */
export class Sound {
  ctx: AudioContext | null = null;
  master!: GainNode;
  private crowdGain!: GainNode;
  private crowdFilter!: BiquadFilterNode;
  private noiseBuf!: AudioBuffer;
  private excitement = 0;
  muted = false;

  start() {
    if (this.ctx) {
      this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(ctx.destination);
    // 2 s of noise reused everywhere
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.04 * w) / 1.04; // brown-ish
      d[i] = last * 3 + w * 0.15;
    }
    // crowd bed
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    this.crowdFilter = ctx.createBiquadFilter();
    this.crowdFilter.type = 'bandpass';
    this.crowdFilter.frequency.value = 600;
    this.crowdFilter.Q.value = 0.6;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.18;
    src.connect(this.crowdFilter).connect(this.crowdGain).connect(this.master);
    src.start();
  }

  volume = 0.7;

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master && !this.muted) this.master.gain.value = v;
  }

  /** 0..1 how dangerous the play is (ball near goal) */
  setExcitement(x: number, dt: number) {
    if (!this.ctx) return;
    this.excitement += (x - this.excitement) * Math.min(1, dt * 1.5);
    const t = this.ctx.currentTime;
    this.crowdGain.gain.setTargetAtTime(0.14 + this.excitement * 0.22, t, 0.3);
    this.crowdFilter.frequency.setTargetAtTime(520 + this.excitement * 500, t, 0.3);
  }

  private noise(dur: number, type: BiquadFilterType, freq: number, q: number, gain: number, attack = 0.002, delay = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
    return { f, g, t };
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', endFreq?: number, delay = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  kick(strength: number) {
    if (!this.ctx) return;
    const s = Math.min(1, strength / 30);
    this.tone(150 + s * 60, 0.12, 0.25 + s * 0.45, 'sine', 55);
    this.noise(0.06, 'highpass', 1800, 0.7, 0.1 + s * 0.25);
  }

  bounce(strength: number) {
    if (!this.ctx) return;
    const s = Math.min(1, strength / 12);
    this.tone(110, 0.09, 0.08 + s * 0.2, 'sine', 60);
  }

  post(strength: number) {
    if (!this.ctx) return;
    const s = Math.min(1, strength / 25);
    for (const [f, g] of [[523, 0.35], [1307, 0.2], [2213, 0.12], [3120, 0.06]]) this.tone(f, 1.2, g * (0.4 + s * 0.6), 'sine');
    this.crowdReact('ooh');
  }

  net(strength: number) {
    if (!this.ctx) return;
    const s = Math.min(1, strength / 25);
    this.noise(0.45, 'bandpass', 2500, 0.8, 0.12 + s * 0.25, 0.02);
  }

  whistle(blasts = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    for (let i = 0; i < blasts; i++) {
      const long = blasts === 2 || (blasts === 3 && i === 2);
      const dur = long ? 0.75 : 0.28;
      const delay = i * 0.42;
      const o = this.tone(2950, dur, 0.18, 'square', undefined, delay);
      const lfo = ctx.createOscillator();
      const lg = ctx.createGain();
      lfo.frequency.value = 28;
      lg.gain.value = 70;
      lfo.connect(lg).connect(o.frequency);
      lfo.start(ctx.currentTime + delay);
      lfo.stop(ctx.currentTime + delay + dur);
    }
  }

  /** cartoon "boing" for bros bumping / falling */
  bonk(strength = 5) {
    if (!this.ctx) return;
    const s = Math.min(1, strength / 10);
    this.tone(380 + Math.random() * 120, 0.22, 0.12 + s * 0.2, 'sine', 120);
    this.noise(0.08, 'lowpass', 600, 0.7, 0.15 + s * 0.2);
  }

  /** springy cartoon "boing" (inflatable walls, countdown) */
  boing(strength = 5) {
    if (!this.ctx) return;
    const s = Math.min(1, strength / 12);
    const o = this.tone(180 + Math.random() * 40, 0.35, 0.1 + s * 0.18, 'sine');
    o.frequency.exponentialRampToValueAtTime(520, this.ctx.currentTime + 0.12);
    o.frequency.exponentialRampToValueAtTime(260, this.ctx.currentTime + 0.33);
  }

  /** quick "hup" for jumps / dives */
  whoosh() {
    if (!this.ctx) return;
    this.noise(0.25, 'bandpass', 1400, 1.5, 0.12, 0.05);
  }

  crowdReact(kind: 'goal' | 'ooh' | 'cheer') {
    if (!this.ctx) return;
    if (kind === 'goal') {
      const { f, t } = this.noise(4.5, 'bandpass', 900, 0.5, 0.55, 0.25);
      f.frequency.setValueAtTime(700, t);
      f.frequency.linearRampToValueAtTime(1300, t + 1);
      this.noise(3, 'bandpass', 1800, 1.2, 0.18, 0.4, 0.2);
    } else if (kind === 'ooh') {
      const { f, t } = this.noise(1.6, 'bandpass', 500, 2, 0.35, 0.2);
      f.frequency.setValueAtTime(420, t);
      f.frequency.linearRampToValueAtTime(320, t + 1.5);
    } else {
      this.noise(1.4, 'bandpass', 1000, 0.8, 0.25, 0.15);
    }
  }
}

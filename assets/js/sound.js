/**
 * Procedural Page-Turn Audio Synthesizer (Web Audio API)
 * Generates subtle, organic paper rustle sounds with zero external assets.
 */
export class PageSoundEngine {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.ctx = null;
    this.noiseBuffer = null;
  }

  setEnabled(value) {
    this.enabled = Boolean(value);
  }

  _ensureContext() {
    if (!this.enabled) return null;
    try {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        this.ctx = new AudioCtx();
      }
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      if (!this.noiseBuffer && this.ctx) {
        const duration = 0.32;
        const sampleRate = this.ctx.sampleRate;
        const length = Math.floor(sampleRate * duration);
        const buffer = this.ctx.createBuffer(1, length, sampleRate);
        const data = buffer.getChannelData(0);
        // Pink-ish filtered noise for soft matte paper timbre
        let b0 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i < length; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.997 * b0 + white * 0.029;
          b1 = 0.985 * b1 + white * 0.032;
          b2 = 0.950 * b2 + white * 0.048;
          data[i] = (b0 + b1 + b2 + white * 0.12) * 0.55;
        }
        this.noiseBuffer = buffer;
      }
      return this.ctx;
    } catch {
      return null;
    }
  }

  playFlip(direction = 'next') {
    if (!this.enabled) return;
    const ctx = this._ensureContext();
    if (!ctx || !this.noiseBuffer) return;

    try {
      const now = ctx.currentTime;
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;

      const bandpass = ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.Q.setValueAtTime(1.15, now);

      const startFreq = direction === 'next' ? 1150 : 1450;
      const midFreq = direction === 'next' ? 2350 : 1850;
      const endFreq = direction === 'next' ? 780 : 680;

      bandpass.frequency.setValueAtTime(startFreq, now);
      bandpass.frequency.exponentialRampToValueAtTime(midFreq, now + 0.09);
      bandpass.frequency.exponentialRampToValueAtTime(endFreq, now + 0.25);

      const highshelf = ctx.createBiquadFilter();
      highshelf.type = 'highshelf';
      highshelf.frequency.setValueAtTime(3200, now);
      highshelf.gain.setValueAtTime(-6, now);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.11, now + 0.045);
      gain.gain.exponentialRampToValueAtTime(0.065, now + 0.14);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);

      source.connect(bandpass);
      bandpass.connect(highshelf);
      highshelf.connect(gain);
      gain.connect(ctx.destination);

      source.start(now);
      source.stop(now + 0.28);
    } catch {
      // Ignore audio errors gracefully
    }
  }
}

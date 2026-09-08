type MusicPhase = "breakwater-quay" | "lock-engine";
interface Track {
  id: MusicPhase;
  file: string;
  seconds: number;
  loopStart: number;
  loopEnd: number;
}
interface MusicVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  phase: MusicPhase;
  start: number;
  end: number | null;
}

/** Two authored arrangements share one local musical clock. No gameplay timing enters this bus. */
export class MissionMusic {
  private readonly bus: GainNode;
  private readonly buffers = new Map<MusicPhase, { buffer: AudioBuffer; track: Track }>();
  private readonly voices = new Set<MusicVoice>();
  private readonly abort = new AbortController();
  private loading?: Promise<void>;
  private enabled = false;
  private playing = false;
  private disposed = false;
  private phase: MusicPhase = "breakwater-quay";
  private origin = 0;
  private offset = 0;
  private readonly beat = 60 / 144;
  private readonly transitions: Array<{ phase: MusicPhase; when: number; offset: number }> = [];
  constructor(private readonly context: AudioContext) {
    this.bus = context.createGain();
    this.bus.gain.value = 0.35;
    this.bus.connect(context.destination);
  }
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (!enabled) {
      this.stopVoices();
      return;
    }
    if (!this.buffers.size && !this.loading) {
      this.loading = this.load().finally(() => {
        this.loading = undefined;
      });
    }
    await this.loading;
    if (this.enabled && this.playing && !this.voices.size && !this.disposed)
      this.schedule(this.context.currentTime);
  }
  private async load(): Promise<void> {
    const request = async (path: string) => {
      const response = await fetch(path, { signal: this.abort.signal });
      if (!response.ok) throw new Error(`Missing mission music ${path}`);
      return response;
    };
    const metadata = (await (await request("/assets/audio/breakwater-music.json")).json()) as {
      tracks: Track[];
    };
    if (metadata.tracks.length !== 2) throw new Error("Invalid mission arrangements");
    const loaded = await Promise.all(
      metadata.tracks.map(async (track) => {
        if (
          !["breakwater-quay", "lock-engine"].includes(track.id) ||
          track.seconds > 30 ||
          track.seconds < 20
        )
          throw new Error("Invalid mission loop");
        const buffer = await this.context.decodeAudioData(
          await (await request(`/${track.file}`)).arrayBuffer(),
        );
        if (Math.abs(buffer.duration - track.seconds) > 1 / buffer.sampleRate)
          throw new Error("Music decode changed the loop duration");
        return { buffer, track };
      }),
    );
    if (
      loaded.reduce((sum, item) => sum + item.buffer.length * item.buffer.numberOfChannels * 4, 0) >
      24 * 1024 * 1024
    )
      throw new Error("Music decode budget exceeded");
    if (!this.disposed) for (const item of loaded) this.buffers.set(item.track.id, item);
  }
  setVolume(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid music volume");
    this.bus.gain.setTargetAtTime(value, this.context.currentTime, 0.015);
  }
  setPhase(phase: MusicPhase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    if (!this.playing || !this.enabled || this.buffers.size !== 2) return;
    const now = this.context.currentTime,
      bar = this.beat * 4;
    const when = this.origin + Math.ceil((now - this.origin + 0.03) / bar) * bar;
    // There are at most an outgoing and incoming arrangement, even after rapid inspector edits.
    for (const voice of [...this.voices]) {
      if (voice.start > now || voice.end !== null) this.release(voice, true);
      else {
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(1, when);
        voice.gain.gain.linearRampToValueAtTime(0, when + this.beat);
        voice.end = when + this.beat;
        voice.source.stop(voice.end);
      }
    }
    this.schedule(when, this.beat);
  }
  play(): void {
    if (this.playing || this.disposed) return;
    this.playing = true;
    this.origin = this.context.currentTime - this.offset;
    if (this.enabled && this.buffers.size === 2) this.schedule(this.context.currentTime);
  }
  pause(): void {
    if (this.playing) this.offset = this.context.currentTime - this.origin;
    this.playing = false;
    this.stopVoices();
  }
  finish(): void {
    if (this.playing) this.offset = this.context.currentTime - this.origin;
    this.playing = false;
    const now = this.context.currentTime;
    for (const voice of [...this.voices]) {
      if (voice.start > now) this.release(voice, true);
      else {
        voice.gain.gain.cancelAndHoldAtTime(now);
        voice.gain.gain.linearRampToValueAtTime(0, now + 0.6);
        voice.end = now + 0.6;
        voice.source.stop(voice.end);
      }
    }
  }
  reset(): void {
    this.pause();
    this.phase = "breakwater-quay";
    this.offset = 0;
    this.transitions.length = 0;
  }
  private schedule(when: number, fade = 0.02): void {
    const item = this.buffers.get(this.phase);
    if (!item) return;
    const source = this.context.createBufferSource(),
      gain = this.context.createGain(),
      offset =
        (((when - this.origin) % item.track.seconds) + item.track.seconds) % item.track.seconds;
    source.buffer = item.buffer;
    source.loop = true;
    source.loopStart = item.track.loopStart;
    source.loopEnd = item.track.loopEnd;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(1, when + fade);
    source.connect(gain).connect(this.bus);
    const voice: MusicVoice = { source, gain, phase: this.phase, start: when, end: null };
    this.voices.add(voice);
    source.onended = () => this.release(voice);
    source.start(when, offset);
    this.transitions.push({ phase: this.phase, when, offset });
    if (this.transitions.length > 128) this.transitions.shift();
  }
  private release(voice: MusicVoice, stop = false): void {
    if (!this.voices.delete(voice)) return;
    voice.source.onended = null;
    if (stop) voice.source.stop();
    voice.source.disconnect();
    voice.gain.disconnect();
  }
  private stopVoices(): void {
    for (const voice of [...this.voices]) this.release(voice, true);
  }
  connect(destination: AudioNode): void {
    this.bus.connect(destination);
  }
  disconnect(destination: AudioNode): void {
    this.bus.disconnect(destination);
  }
  dispose(): void {
    this.disposed = true;
    this.abort.abort();
    this.pause();
    this.bus.disconnect();
    this.buffers.clear();
  }
  inspect() {
    return {
      ready: this.buffers.size === 2,
      enabled: this.enabled,
      playing: this.playing,
      phase: this.phase,
      voices: this.voices.size,
      seconds: this.playing ? this.context.currentTime - this.origin : this.offset,
      decodedBytes: [...this.buffers.values()].reduce(
        (sum, item) => sum + item.buffer.length * item.buffer.numberOfChannels * 4,
        0,
      ),
      transitions: [...this.transitions],
    };
  }
}

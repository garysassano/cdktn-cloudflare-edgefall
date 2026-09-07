import type { CombatLab } from "../game/labs/combat.js";
import { COMBAT_AUDIO, type CombatCue, combatAudioCues } from "../shared/animation/combat-audio.js";

/** Bounded sample playback, explicitly unlocked by a user gesture. No oscillator or gameplay clock. */
export class CastAudio {
  private context?: AudioContext;
  private gain?: GainNode;
  private capture?: MediaStreamAudioDestinationNode;
  private recorder?: MediaRecorder;
  private loading?: Promise<void>;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly voices = new Set<AudioBufferSourceNode>();
  private readonly recent = new Set<string>();
  private readonly cues: CombatCue[] = [];
  private enabled = false;
  private ready = false;
  private volume = 0.4;
  private dropped = 0;
  private lastTick = -1;
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (!enabled) {
      this.hush();
      return;
    }
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
      this.capture = this.context.createMediaStreamDestination();
      this.gain.connect(this.capture);
    }
    if (!this.ready && !this.loading) {
      const context = this.context;
      this.loading = Promise.all(
        [...new Set(Object.values(COMBAT_AUDIO).map((cue) => cue.file))].map(async (file) => {
          const response = await fetch(`/assets/audio/${file}`);
          if (!response.ok) throw new Error(`Missing audio sample ${file}`);
          this.buffers.set(file, await context.decodeAudioData(await response.arrayBuffer()));
        }),
      )
        .then(() => {
          this.ready = true;
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    await this.context.resume();
    await this.loading;
  }
  setVolume(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid audio volume");
    this.volume = value;
    if (this.gain) this.gain.gain.value = value;
  }
  hush(): void {
    for (const voice of this.voices) voice.stop();
    this.voices.clear();
  }
  reset(): void {
    this.hush();
    this.recent.clear();
    this.cues.length = 0;
    this.lastTick = -1;
    this.dropped = 0;
  }
  consume(before: CombatLab, next: CombatLab, footfalls: readonly number[]): void {
    if (next.tick === this.lastTick) return;
    this.lastTick = next.tick;
    if (!this.enabled || !this.ready || this.context?.state !== "running" || !this.gain) return;
    for (const cue of combatAudioCues(before, next, footfalls)) {
      if (this.recent.has(cue.id)) continue;
      this.recent.add(cue.id);
      if (this.recent.size > 1024) this.recent.delete(this.recent.values().next().value ?? "");
      const profile = COMBAT_AUDIO[cue.kind],
        buffer = this.buffers.get(profile.file);
      if (!buffer || this.voices.size >= 24) {
        this.dropped++;
        continue;
      }
      const source = this.context.createBufferSource(),
        gain = this.context.createGain(),
        pan = this.context.createStereoPanner();
      source.buffer = buffer;
      source.playbackRate.value = profile.rate;
      gain.gain.value = profile.gain;
      pan.pan.value = Math.max(-0.7, Math.min(0.7, (cue.x - 192) / 192));
      source.connect(gain).connect(pan).connect(this.gain);
      this.voices.add(source);
      source.onended = () => {
        this.voices.delete(source);
        source.disconnect();
        gain.disconnect();
        pan.disconnect();
      };
      source.start();
      this.cues.push(cue);
      if (this.cues.length > 2048) this.cues.shift();
    }
  }
  startCapture(video?: MediaStream): void {
    if (
      !this.enabled ||
      !this.ready ||
      this.context?.state !== "running" ||
      !this.capture ||
      this.recorder
    )
      throw new Error("Enable audio before starting a new capture");
    const stream = video
      ? new MediaStream([...video.getVideoTracks(), ...this.capture.stream.getAudioTracks()])
      : this.capture.stream;
    this.recorder = new MediaRecorder(stream, {
      mimeType: video ? "video/webm;codecs=vp9,opus" : "audio/webm;codecs=opus",
    });
    this.recorder.start();
  }
  stopCapture(): Promise<Blob> {
    const recorder = this.recorder;
    if (recorder?.state !== "recording") throw new Error("No active audio capture");
    return new Promise((resolve, reject) => {
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onerror = () => reject(new Error("Audio capture failed"));
      recorder.onstop = () => {
        for (const track of recorder.stream.getVideoTracks()) track.stop();
        this.recorder = undefined;
        resolve(new Blob(chunks, { type: recorder.mimeType }));
      };
      recorder.stop();
    });
  }
  inspect() {
    return {
      enabled: this.enabled,
      ready: this.ready,
      state: this.context?.state ?? "locked",
      decodedSamples: this.buffers.size,
      activeVoices: this.voices.size,
      dropped: this.dropped,
      cues: [...this.cues],
    };
  }
}

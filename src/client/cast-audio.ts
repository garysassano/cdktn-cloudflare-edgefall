import type { CombatLab } from "../game/labs/combat.js";
import { COMBAT_AUDIO, type CombatCue, combatAudioCues } from "../shared/animation/combat-audio.js";
import { MissionMusic } from "./mission-music.js";

/** Bounded sample playback, explicitly unlocked by a user gesture. No oscillator or gameplay clock. */
export class CastAudio {
  private context?: AudioContext;
  private music?: MissionMusic;
  private musicEnabled = false;
  private musicVolume = 0.35;
  private gain?: GainNode;
  private capture?: MediaStreamAudioDestinationNode;
  private recorder?: MediaRecorder;
  private captureChunks: Blob[] = [];
  private loading?: Promise<void>;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly voices = new Map<
    AudioBufferSourceNode,
    { end: number; gain: GainNode; pan: StereoPannerNode }
  >();
  private readonly recent = new Set<string>();
  private readonly cues: CombatCue[] = [];
  private enabled = false;
  private ready = false;
  private volume = 0.4;
  private dropped = 0;
  private maxActiveVoices = 0;
  private lastTick = -1;
  private listenerX = 192;
  private lastAudioTime = -1;
  private stalledAudioTicks = 0;
  private maxStalledAudioTicks = 0;
  private readonly droppedExamples: Array<{
    tick: number;
    kind: string;
    audioTime: number;
    earliestEnd: number;
  }> = [];
  setListenerX(x: number): void {
    if (!Number.isFinite(x)) throw new Error("Invalid audio listener position");
    this.listenerX = x;
  }
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    if (!enabled) {
      this.hush();
      await this.music?.setEnabled(false);
      return;
    }
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: 48000 });
      this.music = new MissionMusic(this.context);
      this.music.setVolume(this.musicVolume);
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.context.destination);
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
    await this.music?.setEnabled(this.musicEnabled && this.enabled);
  }
  async setMusicEnabled(enabled: boolean): Promise<void> {
    this.musicEnabled = enabled;
    await this.music?.setEnabled(enabled && this.enabled);
  }
  setMusicVolume(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid music volume");
    this.musicVolume = value;
    this.music?.setVolume(value);
  }
  playMusic(): void {
    if (this.enabled) this.music?.play();
  }
  setMusicPhase(boss: boolean): void {
    this.music?.setPhase(boss ? "lock-engine" : "breakwater-quay");
  }
  finishMusic(): void {
    this.music?.finish();
  }
  setVolume(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid audio volume");
    this.volume = value;
    if (this.gain) this.gain.gain.value = value;
  }
  hush(): void {
    this.music?.pause();
    for (const voice of this.voices.keys()) {
      voice.stop();
      this.releaseVoice(voice);
    }
  }
  private releaseVoice(source: AudioBufferSourceNode): void {
    const voice = this.voices.get(source);
    if (!voice) return;
    source.onended = null;
    source.disconnect();
    voice.gain.disconnect();
    voice.pan.disconnect();
    this.voices.delete(source);
  }
  reset(): void {
    this.hush();
    this.music?.reset();
    this.recent.clear();
    this.cues.length = 0;
    this.lastTick = -1;
    this.dropped = 0;
    this.maxActiveVoices = 0;
    this.droppedExamples.length = 0;
    this.lastAudioTime = -1;
    this.stalledAudioTicks = this.maxStalledAudioTicks = 0;
  }
  consume(
    before: CombatLab,
    next: CombatLab,
    footfalls: readonly number[],
    extraCues: readonly CombatCue[] = [],
  ): void {
    if (next.tick === this.lastTick) return;
    this.lastTick = next.tick;
    if (!this.enabled || !this.ready || this.context?.state !== "running" || !this.gain) return;
    const audioTime = this.context.currentTime;
    this.stalledAudioTicks = audioTime === this.lastAudioTime ? this.stalledAudioTicks + 1 : 0;
    this.lastAudioTime = audioTime;
    this.maxStalledAudioTicks = Math.max(this.maxStalledAudioTicks, this.stalledAudioTicks);
    // Audio completion callbacks can reach JS late. Only still-scheduled samples own a voice.
    for (const [source, voice] of this.voices)
      if (voice.end <= audioTime) this.releaseVoice(source);
    for (const cue of [...combatAudioCues(before, next, footfalls), ...extraCues]) {
      if (this.recent.has(cue.id)) continue;
      this.recent.add(cue.id);
      if (this.recent.size > 1024) this.recent.delete(this.recent.values().next().value ?? "");
      const profile = COMBAT_AUDIO[cue.kind],
        buffer = this.buffers.get(profile.file);
      if (!buffer || this.voices.size >= 32) {
        this.dropped++;
        if (this.droppedExamples.length < 32)
          this.droppedExamples.push({
            tick: next.tick,
            kind: cue.kind,
            audioTime,
            earliestEnd: Math.min(...[...this.voices.values()].map((v) => v.end)),
          });
        continue;
      }
      const source = this.context.createBufferSource(),
        gain = this.context.createGain(),
        pan = this.context.createStereoPanner();
      source.buffer = buffer;
      source.playbackRate.value = profile.rate;
      gain.gain.value = profile.gain;
      const start = this.context.currentTime,
        duration = Math.min(
          buffer.duration / profile.rate,
          "duration" in profile ? profile.duration : 0.75,
        ),
        fade = Math.min(0.015, duration / 4);
      gain.gain.setValueAtTime(profile.gain, start + duration - fade);
      gain.gain.linearRampToValueAtTime(0, start + duration);
      pan.pan.value = Math.max(-0.7, Math.min(0.7, (cue.x - this.listenerX) / 192));
      source.connect(gain).connect(pan).connect(this.gain);
      this.voices.set(source, { end: start + duration, gain, pan });
      this.maxActiveVoices = Math.max(this.maxActiveVoices, this.voices.size);
      source.onended = () => this.releaseVoice(source);
      source.start(start);
      source.stop(start + duration);
      this.cues.push(cue);
      if (this.cues.length > 2048) this.cues.shift();
    }
  }
  startCapture(video?: MediaStream): void {
    if (
      !this.enabled ||
      !this.ready ||
      this.context?.state !== "running" ||
      !this.gain ||
      this.recorder
    )
      throw new Error("Enable audio before starting a new capture");
    this.capture = this.context.createMediaStreamDestination();
    this.gain.connect(this.capture);
    this.music?.connect(this.capture);
    const stream = video
      ? new MediaStream([...video.getVideoTracks(), ...this.capture.stream.getAudioTracks()])
      : this.capture.stream;
    this.recorder = new MediaRecorder(stream, {
      mimeType: video ? "video/webm;codecs=vp9,opus" : "audio/webm;codecs=opus",
    });
    this.captureChunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data.size) this.captureChunks.push(event.data);
    };
    this.recorder.start(1000);
  }
  stopCapture(): Promise<Blob> {
    const recorder = this.recorder;
    if (recorder?.state !== "recording") throw new Error("No active audio capture");
    return new Promise((resolve, reject) => {
      recorder.onerror = () => reject(new Error("Audio capture failed"));
      recorder.onstop = () => {
        for (const track of recorder.stream.getVideoTracks()) track.stop();
        if (this.capture) {
          this.gain?.disconnect(this.capture);
          this.music?.disconnect(this.capture);
          for (const track of this.capture.stream.getTracks()) track.stop();
          this.capture = undefined;
        }
        this.recorder = undefined;
        const blob = new Blob(this.captureChunks, { type: recorder.mimeType });
        this.captureChunks = [];
        resolve(blob);
      };
      recorder.stop();
    });
  }
  inspect() {
    return {
      enabled: this.enabled,
      ready: this.ready && (!this.musicEnabled || this.music?.inspect().ready === true),
      state: this.context?.state ?? "locked",
      contextSeconds: this.context?.currentTime ?? 0,
      decodedSamples: this.buffers.size,
      decodedBytes: [...this.buffers.values()].reduce(
        (sum, buffer) => sum + buffer.length * buffer.numberOfChannels * 4,
        0,
      ),
      music: this.music?.inspect() ?? null,
      activeVoices: this.voices.size,
      maxActiveVoices: this.maxActiveVoices,
      voiceBudget: 32,
      dropped: this.dropped,
      droppedExamples: [...this.droppedExamples],
      maxStalledAudioTicks: this.maxStalledAudioTicks,
      cues: [...this.cues],
    };
  }
  dispose(): void {
    if (this.recorder) {
      this.recorder.ondataavailable = this.recorder.onstop = this.recorder.onerror = null;
      if (this.recorder.state === "recording") this.recorder.stop();
      for (const track of this.recorder.stream.getTracks()) track.stop();
      this.recorder = undefined;
      this.captureChunks = [];
    }
    if (this.capture) {
      this.gain?.disconnect(this.capture);
      this.music?.disconnect(this.capture);
      for (const track of this.capture.stream.getTracks()) track.stop();
      this.capture = undefined;
    }
    this.hush();
    this.music?.dispose();
    this.gain?.disconnect();
    void this.context?.close();
  }
}

import type { CombatLab } from "../game/labs/combat.js";
import { type CombatCue, combatAudioLoops } from "../shared/animation/combat-audio.js";
import { SFX_LOOPS, SFX_PROFILES, SFX_VOICES } from "../shared/animation/sfx-profile.js";
import { CombatMixer } from "./combat-mixer.js";
import { MissionMusic } from "./mission-music.js";
import { SceneAudioOutput } from "./scene-audio-output.js";

/** Bounded sample playback, explicitly unlocked by a user gesture. No oscillator or gameplay clock. */
export class CastAudio {
  private context?: AudioContext;
  private music?: MissionMusic;
  private output?: SceneAudioOutput;
  private musicEnabled = false;
  private musicVolume = 0.35;
  private gain?: GainNode;
  private capture?: MediaStreamAudioDestinationNode;
  private recorder?: MediaRecorder;
  private captureChunks: Blob[] = [];
  private rejectCapture?: (reason: Error) => void;
  private loading?: Promise<void>;
  private readonly buffers = new Map<string, AudioBuffer>();
  private mixer?: CombatMixer;
  private latest?: CombatLab;
  private playing = false;
  private epoch = 0;
  private disposed = false;
  private readonly abort = new AbortController();
  private enabled = false;
  private ready = false;
  private volume = 0.4;
  private lastTick = -1;
  private listenerX = 192;
  private lastAudioTime = -1;
  private stalledAudioTicks = 0;
  private maxStalledAudioTicks = 0;
  setListenerX(x: number): void {
    if (!Number.isFinite(x)) throw new Error("Invalid audio listener position");
    this.listenerX = x;
    this.mixer?.setListenerX(x);
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) throw new Error("Audio scene is disposed");
    this.enabled = enabled;
    if (!enabled) {
      this.hush();
      await this.music?.setEnabled(false);
      return;
    }
    if (!this.context) {
      this.context = new AudioContext({ sampleRate: 48000 });
      this.output = new SceneAudioOutput(this.context);
      this.music = new MissionMusic(this.context, this.output.input);
      this.music.setVolume(this.musicVolume);
      this.gain = this.context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.output.input);
      this.mixer = new CombatMixer(this.context, this.gain, this.buffers);
      this.mixer.setListenerX(this.listenerX);
    }
    if (!this.ready && !this.loading) {
      const context = this.context;
      this.loading = Promise.all(
        [...new Set(Object.values(SFX_PROFILES).flatMap((cue) => cue.files))].map(async (file) => {
          const response = await fetch(`/assets/audio/${file}`, { signal: this.abort.signal });
          if (!response.ok) throw new Error(`Missing audio sample ${file}`);
          const buffer = await context.decodeAudioData(await response.arrayBuffer());
          if (!this.disposed) this.buffers.set(file, buffer);
        }),
      )
        .then(() => {
          this.ready = !this.disposed;
        })
        .finally(() => {
          this.loading = undefined;
        });
    }
    await this.context.resume();
    await this.loading;
    if (this.disposed) return;
    if (this.enabled && this.playing && this.latest)
      this.mixer?.syncLoops(combatAudioLoops(this.latest));
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
  finish(): void {
    this.playing = false;
    this.mixer?.finishLoops();
    this.music?.finish();
  }
  resume(state: CombatLab): void {
    this.playing = true;
    this.latest = state;
    if (this.enabled && this.ready && this.context?.state === "running")
      this.mixer?.syncLoops(combatAudioLoops(state));
  }
  setVolume(value: number): void {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid audio volume");
    this.volume = value;
    if (this.gain) this.gain.gain.value = value;
  }
  hush(): void {
    this.playing = false;
    this.music?.pause();
    this.mixer?.hush();
  }
  reset(): void {
    this.hush();
    this.music?.reset();
    this.mixer?.reset();
    this.latest = undefined;
    this.epoch++;
    this.lastTick = -1;
    this.lastAudioTime = -1;
    this.stalledAudioTicks = this.maxStalledAudioTicks = 0;
  }
  consume(next: CombatLab, cues: readonly CombatCue[], continuous = false): void {
    if (next.tick <= this.lastTick) return;
    this.lastTick = next.tick;
    this.latest = next;
    this.playing = continuous;
    if (!this.enabled || !this.ready || this.context?.state !== "running") return;
    const audioTime = this.context.currentTime;
    this.stalledAudioTicks = audioTime === this.lastAudioTime ? this.stalledAudioTicks + 1 : 0;
    this.lastAudioTime = audioTime;
    this.maxStalledAudioTicks = Math.max(this.maxStalledAudioTicks, this.stalledAudioTicks);
    this.mixer?.play(cues, this.epoch);
    this.mixer?.syncLoops(continuous ? combatAudioLoops(next) : []);
  }
  startCapture(video?: MediaStream): void {
    if (
      !this.enabled ||
      !this.inspect().ready ||
      this.context?.state !== "running" ||
      !this.gain ||
      this.recorder
    )
      throw new Error("Enable audio before starting a new capture");
    this.capture = this.context.createMediaStreamDestination();
    this.output?.connect(this.capture);
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
      this.rejectCapture = reject;
      recorder.onerror = () => {
        this.rejectCapture = undefined;
        reject(new Error("Audio capture failed"));
      };
      recorder.onstop = () => {
        this.rejectCapture = undefined;
        for (const track of recorder.stream.getVideoTracks()) track.stop();
        if (this.capture) {
          this.output?.disconnect(this.capture);
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
      output: { linearThrough: 0.7, softCeiling: 0.85, oversample: "4x" },
      ...(this.mixer?.inspect() ?? {
        activeVoices: 0,
        audibleVoices: 0,
        maxActiveVoices: 0,
        sourceNodes: 0,
        maxSourceNodes: 0,
        voiceBudget: SFX_VOICES,
        loopBudget: SFX_LOOPS,
        loops: [],
        virtualLoops: [],
        loopChanges: [],
        dropped: 0,
        criticalDropped: 0,
        stolen: 0,
        virtualized: 0,
        coalesced: 0,
        droppedExamples: [],
        cues: [],
      }),
      maxStalledAudioTicks: this.maxStalledAudioTicks,
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = this.ready = false;
    this.abort.abort();
    this.rejectCapture?.(new Error("Audio scene disposed during capture"));
    this.rejectCapture = undefined;
    if (this.recorder) {
      this.recorder.ondataavailable = this.recorder.onstop = this.recorder.onerror = null;
      if (this.recorder.state === "recording") this.recorder.stop();
      for (const track of this.recorder.stream.getTracks()) track.stop();
      this.recorder = undefined;
      this.captureChunks = [];
    }
    if (this.capture) {
      this.output?.disconnect(this.capture);
      for (const track of this.capture.stream.getTracks()) track.stop();
      this.capture = undefined;
    }
    this.hush();
    this.music?.dispose();
    this.buffers.clear();
    this.gain?.disconnect();
    this.output?.dispose();
    void this.context?.close();
  }
}

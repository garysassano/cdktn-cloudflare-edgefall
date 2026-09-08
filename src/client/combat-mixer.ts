import type { CombatCue, CombatLoop } from "../shared/animation/combat-audio.js";
import {
  COMBAT_AUDIO,
  SFX_LOOPS,
  SFX_PROFILES,
  SFX_VOICES,
  type SfxName,
  type VoiceIntent,
  admitSfx,
  sfxSpatial,
  sfxVariation,
} from "../shared/animation/sfx-profile.js";

interface Voice extends VoiceIntent {
  source: AudioBufferSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
  end: number;
  loopId: string | null;
  x: number;
  baseGain: number;
}

/** A bounded sample graph. A stolen slot fades for 5 ms before its replacement can become audible. */
export class CombatMixer {
  private readonly voices = new Map<string, Voice>();
  private readonly retiring = new Map<string, Voice>();
  private readonly recent = new Set<string>();
  private readonly cooldowns = new Map<string, number>();
  private readonly cues: CombatCue[] = [];
  private readonly decisions: Array<{ id: string; kind: SfxName; reason: string }> = [];
  private readonly loopChanges: Array<{ id: string; kind: SfxName; reason: string; time: number }> =
    [];
  private serial = 0;
  private listenerX = 192;
  private dropped = 0;
  private criticalDropped = 0;
  private stolen = 0;
  private virtualized = 0;
  private coalesced = 0;
  private maxActiveVoices = 0;
  private maxSourceNodes = 0;
  private desiredLoops: readonly CombatLoop[] = [];
  constructor(
    private readonly context: AudioContext,
    private readonly output: GainNode,
    private readonly buffers: ReadonlyMap<string, AudioBuffer>,
  ) {}
  setListenerX(x: number) {
    this.listenerX = x;
  }
  private drop(id: string, kind: SfxName, reason: string) {
    if (reason === "inaudible") this.virtualized++;
    else if (reason === "cooldown") this.coalesced++;
    else {
      this.dropped++;
      if (SFX_PROFILES[kind].priority >= 90) this.criticalDropped++;
    }
    this.decisions.push({ id, kind, reason });
    if (this.decisions.length > 64) this.decisions.shift();
  }
  private release(voice: Voice) {
    voice.source.onended = null;
    voice.source.disconnect();
    voice.gain.disconnect();
    voice.pan.disconnect();
    this.voices.delete(voice.id);
    this.retiring.delete(voice.id);
  }
  private prune() {
    for (const voice of [...this.voices.values(), ...this.retiring.values()])
      if (voice.end <= this.context.currentTime) this.release(voice);
  }
  private change(voice: Pick<Voice, "id" | "kind">, reason: string) {
    this.loopChanges.push({ ...voice, reason, time: this.context.currentTime });
    if (this.loopChanges.length > 128) this.loopChanges.shift();
  }
  private finishLoop(voice: Voice, reason: string) {
    if (!voice.loopId) return;
    this.change({ id: voice.loopId, kind: voice.kind }, reason);
    voice.loopId = null;
    const now = this.context.currentTime;
    voice.gain.gain.cancelAndHoldAtTime(now);
    voice.gain.gain.linearRampToValueAtTime(0, now + 0.02);
    voice.end = now + 0.02;
    voice.source.stop(voice.end);
  }
  private allocate(kind: SfxName, identity: string, x: number, loop: CombatLoop | null) {
    this.prune();
    const profile = SFX_PROFILES[kind],
      variation = sfxVariation(identity, profile),
      spatial = sfxSpatial(x, this.listenerX, profile.range),
      id = `voice:${++this.serial}`,
      intent = {
        id,
        kind,
        level: variation.gain * spatial.attenuation,
        started: this.context.currentTime,
      },
      decision = admitSfx([...this.voices.values()], intent);
    if (!decision.accepted) {
      // Persistent loops are virtual and can be admitted again from current state when space becomes available.
      if (!loop) this.drop(identity, kind, decision.reason);
      return null;
    }
    const buffer = this.buffers.get(variation.file);
    if (!buffer) {
      this.drop(identity, kind, "missing-buffer");
      return null;
    }
    let start = this.context.currentTime;
    if (decision.replace !== null) {
      const victim = this.voices.get(decision.replace);
      if (!victim) throw new Error("Missing allocated voice");
      const now = this.context.currentTime;
      if (victim.loopId)
        this.change({ id: victim.loopId, kind: victim.kind }, "virtualized-for-priority");
      if (victim.started > now) {
        start = victim.started;
        victim.source.stop(now);
        this.release(victim);
      } else {
        start = now + 0.005;
        victim.gain.gain.cancelAndHoldAtTime(now);
        victim.gain.gain.linearRampToValueAtTime(0, start);
        victim.end = start;
        victim.source.stop(start);
        this.voices.delete(victim.id);
        this.retiring.set(victim.id, victim);
      }
      this.stolen++;
    }
    const source = this.context.createBufferSource(),
      gain = this.context.createGain(),
      pan = this.context.createStereoPanner();
    source.buffer = buffer;
    const speed = loop?.rate ?? variation.rate;
    source.playbackRate.value = speed;
    source.loop = profile.loop;
    source.loopStart = 0;
    source.loopEnd = buffer.duration;
    const end = loop ? Number.POSITIVE_INFINITY : start + buffer.duration / speed;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(intent.level, start + (loop ? 0.02 : 0.002));
    if (!loop) {
      gain.gain.setValueAtTime(intent.level, end - Math.min(0.015, buffer.duration / speed / 4));
      gain.gain.linearRampToValueAtTime(0, end);
    }
    pan.pan.value = spatial.pan;
    source.connect(gain).connect(pan).connect(this.output);
    const voice: Voice = {
      ...intent,
      started: start,
      source,
      gain,
      pan,
      end,
      loopId: loop?.id ?? null,
      x,
      baseGain: variation.gain,
    };
    this.voices.set(id, voice);
    source.onended = () => this.release(voice);
    // Phase reconstruction is local and independent of action delivery. Moving loops keep the same source.
    source.start(start);
    if (!loop) source.stop(end);
    else this.change({ id: loop.id, kind }, "start");
    this.maxActiveVoices = Math.max(this.maxActiveVoices, this.voices.size);
    this.maxSourceNodes = Math.max(this.maxSourceNodes, this.voices.size + this.retiring.size);
    return voice;
  }
  play(cues: readonly CombatCue[], scope: number) {
    const played = new Set<string>();
    for (const cue of [...cues].sort(
      (a, b) => COMBAT_AUDIO[b.kind].priority - COMBAT_AUDIO[a.kind].priority,
    )) {
      const key = `${scope}:${cue.id}`;
      if (this.recent.has(key)) continue;
      this.recent.add(key);
      if (this.recent.size > 4096) this.recent.delete(this.recent.values().next().value ?? "");
      const profile = COMBAT_AUDIO[cue.kind],
        cooldownKey = `${scope}:${cue.emitter}:${cue.kind}`;
      if (cue.tick - (this.cooldowns.get(cooldownKey) ?? -10000) < profile.cooldown) {
        this.drop(cue.id, cue.kind, "cooldown");
        continue;
      }
      this.cooldowns.set(cooldownKey, cue.tick);
      if (this.cooldowns.size > 1024)
        this.cooldowns.delete(this.cooldowns.keys().next().value ?? "");
      if (this.allocate(cue.kind, cue.id, cue.x, null)) played.add(cue.id);
    }
    // Preserve event order in inspection even though priority determines admission at a shared audio boundary.
    for (const cue of cues) if (played.delete(cue.id)) this.cues.push(cue);
    if (this.cues.length > 4096) this.cues.splice(0, this.cues.length - 4096);
  }
  syncLoops(loops: readonly CombatLoop[]) {
    this.prune();
    this.desiredLoops = loops;
    for (const voice of this.voices.values()) {
      if (!voice.loopId) continue;
      const desired = loops.find((loop) => loop.id === voice.loopId);
      if (!desired) {
        this.finishLoop(voice, "state-ended");
        continue;
      }
      const spatial = sfxSpatial(desired.x, this.listenerX, SFX_PROFILES[voice.kind].range);
      if (spatial.attenuation === 0) {
        this.finishLoop(voice, "inaudible");
        continue;
      }
      voice.x = desired.x;
      voice.level = voice.baseGain * spatial.attenuation;
      const now = Math.max(this.context.currentTime, voice.started);
      voice.gain.gain.cancelAndHoldAtTime(now);
      voice.gain.gain.linearRampToValueAtTime(voice.level, now + 0.02);
      voice.pan.pan.setTargetAtTime(spatial.pan, now, 0.01);
      voice.source.playbackRate.setTargetAtTime(desired.rate, now, 0.04);
    }
    const candidates = [...loops].sort(
      (a, b) => Math.abs(a.x - this.listenerX) - Math.abs(b.x - this.listenerX),
    );
    for (const loop of candidates)
      if (![...this.voices.values()].some((voice) => voice.loopId === loop.id))
        this.allocate(loop.kind, loop.id, loop.x, loop);
  }
  finishLoops() {
    this.desiredLoops = [];
    for (const voice of this.voices.values()) this.finishLoop(voice, "scene-finished");
  }
  hush() {
    this.desiredLoops = [];
    for (const voice of [...this.voices.values(), ...this.retiring.values()]) {
      if (voice.loopId) this.change({ id: voice.loopId, kind: voice.kind }, "hush");
      voice.source.stop();
      this.release(voice);
    }
  }
  reset() {
    this.hush();
    this.recent.clear();
    this.cooldowns.clear();
    this.cues.length = this.decisions.length = this.loopChanges.length = 0;
    this.dropped = this.criticalDropped = this.stolen = this.virtualized = this.coalesced = 0;
    this.maxActiveVoices = this.maxSourceNodes = 0;
  }
  inspect() {
    this.prune();
    const loops = [...this.voices.values()].filter((voice) => voice.loopId !== null),
      now = this.context.currentTime;
    return {
      activeVoices: this.voices.size,
      audibleVoices: [...this.voices.values(), ...this.retiring.values()].filter(
        (v) => v.started <= now && v.end > now,
      ).length,
      maxActiveVoices: this.maxActiveVoices,
      sourceNodes: this.voices.size + this.retiring.size,
      maxSourceNodes: this.maxSourceNodes,
      voiceBudget: SFX_VOICES,
      loopBudget: SFX_LOOPS,
      loops: loops.map((voice) => ({
        id: voice.loopId,
        kind: voice.kind,
        level: voice.level,
        rate: voice.source.playbackRate.value,
        started: voice.started,
      })),
      virtualLoops: this.desiredLoops
        .filter((loop) => !loops.some((voice) => voice.loopId === loop.id))
        .map((loop) => loop.id),
      loopChanges: [...this.loopChanges],
      dropped: this.dropped,
      criticalDropped: this.criticalDropped,
      stolen: this.stolen,
      virtualized: this.virtualized,
      coalesced: this.coalesced,
      droppedExamples: [...this.decisions],
      cues: [...this.cues],
    };
  }
}

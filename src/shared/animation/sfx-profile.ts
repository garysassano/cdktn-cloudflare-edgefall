export interface SfxProfile {
  files: readonly string[];
  gain: readonly [number, number];
  rate: readonly [number, number];
  priority: number;
  maximum: number;
  /** Per emitter, in accepted simulation ticks. */
  cooldown: number;
  range: number;
  loop: boolean;
}
const cue = (
  names: string,
  gain: number,
  priority: number,
  maximum: number,
  range = 768,
  cooldown = 0,
): SfxProfile => ({
  files: names.split(" ").map((name) => `sfx/${name}.ogg`),
  gain: [gain * 0.94, gain],
  rate: [0.985, 1.015],
  priority,
  maximum,
  cooldown,
  range,
  loop: false,
});

/** Complete benchmark cue policy. Every sample is preloaded; music has a separate bus. */
export const COMBAT_AUDIO = {
  sidearm: cue("sidearm-a sidearm-b", 0.43, 60, 8),
  hmg: cue("hmg-a hmg-b hmg-c", 0.31, 55, 12, 768, 2),
  rifle: cue("rifle-a rifle-b", 0.32, 50, 8),
  shotgun: cue("shotgun-a shotgun-b", 0.52, 65, 4),
  tank: cue("tank-a tank-b", 0.43, 60, 8),
  knife: cue("knife", 0.35, 50, 4, 384),
  bash: cue("bash", 0.48, 65, 4, 512),
  throw: cue("throw", 0.3, 50, 4, 384),
  "grenade-bounce": cue("grenade-bounce", 0.22, 25, 6, 384),
  explosion: cue("explosion-a explosion-b", 0.6, 75, 6),
  shield: cue("shield-a shield-b", 0.3, 30, 16),
  "shield-break": cue("shield-break", 0.45, 70, 4),
  "wood-break": cue("wood-break", 0.4, 45, 4),
  "impact-metal": cue("impact-metal-a impact-metal-b", 0.19, 20, 24),
  "impact-body": cue("impact-body", 0.24, 25, 16),
  "impact-stone": cue("impact-stone", 0.18, 20, 16),
  hurt: cue("hurt", 0.55, 100, 4),
  death: cue("death", 0.52, 100, 4),
  "enemy-death": cue("death", 0.35, 40, 8),
  entry: cue("entry", 0.3, 85, 4),
  step: cue("step-a step-b", 0.12, 10, 8, 320, 3),
  jump: cue("jump", 0.2, 20, 4, 384),
  land: cue("land", 0.32, 30, 4, 512),
  "tank-land": cue("tank-land", 0.43, 55, 4),
  "tank-hit": cue("tank-hit", 0.45, 95, 4),
  "tank-destroyed": cue("tank-destroyed", 0.55, 100, 4),
  board: cue("board", 0.45, 90, 4),
  exit: cue("exit", 0.4, 90, 4),
  eject: cue("eject", 0.48, 95, 4),
  pickup: cue("pickup", 0.32, 80, 4),
  checkpoint: cue("checkpoint", 0.3, 80, 1),
  victory: cue("victory", 0.35, 100, 1),
  defeat: cue("defeat", 0.35, 100, 1),
  "boss-warning": cue("boss-warning", 0.56, 110, 2, 1536),
  "boss-fire": cue("boss-fire", 0.44, 80, 4, 1536),
  "boss-hit": cue("boss-hit", 0.24, 35, 12),
  "boss-destroyed": cue("boss-destroyed", 0.58, 105, 1, 1536),
  "flame-ignite": cue("flame-ignite", 0.32, 60, 4),
  "flame-tail": cue("flame-tail", 0.23, 25, 4),
  "engine-start": cue("engine-start", 0.34, 65, 4),
  "engine-stop": cue("engine-stop", 0.28, 30, 4),
} satisfies Record<string, SfxProfile>;
export const COMBAT_LOOPS = {
  engine: { ...cue("engine-loop", 0.3, 15, 4, 512), rate: [1, 1], loop: true },
  flame: { ...cue("flame-loop", 0.3, 25, 4, 512), rate: [1, 1], loop: true },
} satisfies Record<string, SfxProfile>;
export type CombatCueName = keyof typeof COMBAT_AUDIO;
export type CombatLoopName = keyof typeof COMBAT_LOOPS;
export type SfxName = CombatCueName | CombatLoopName;
export const SFX_PROFILES: Readonly<Record<SfxName, SfxProfile>> = {
  ...COMBAT_AUDIO,
  ...COMBAT_LOOPS,
};
export const SFX_VOICES = 32;
export const SFX_LOOPS = 8;
export interface VoiceIntent {
  id: string;
  kind: SfxName;
  level: number;
  started: number;
}

/** Lowest priority, then quietest, then oldest. A stable ID resolves exact ties. */
function weakest(a: VoiceIntent, b: VoiceIntent) {
  return (
    SFX_PROFILES[a.kind].priority - SFX_PROFILES[b.kind].priority ||
    a.level - b.level ||
    a.started - b.started ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
export function admitSfx(
  voices: readonly VoiceIntent[],
  incoming: VoiceIntent,
):
  | { accepted: true; replace: string | null }
  | { accepted: false; reason: "inaudible" | "priority" } {
  if (incoming.level <= 0) return { accepted: false, reason: "inaudible" };
  const profile = SFX_PROFILES[incoming.kind],
    same = voices.filter((voice) => voice.kind === incoming.kind),
    loops = voices.filter((voice) => SFX_PROFILES[voice.kind].loop),
    candidates =
      same.length >= profile.maximum
        ? same
        : profile.loop && loops.length >= SFX_LOOPS
          ? loops
          : voices.length >= SFX_VOICES
            ? voices
            : [];
  if (!candidates.length) return { accepted: true, replace: null };
  const victim = [...candidates].sort(weakest)[0];
  if (!victim) throw new Error("Missing voice candidate");
  const priority = SFX_PROFILES[victim.kind].priority;
  // Equal-priority loops must be nearer to replace an existing loop; otherwise they would churn every tick.
  if (
    profile.priority < priority ||
    (profile.priority === priority &&
      (incoming.level < victim.level || (profile.loop && incoming.level === victim.level)))
  )
    return { accepted: false, reason: "priority" };
  return { accepted: true, replace: victim.id };
}

export function sfxSpatial(x: number, listener: number, range: number) {
  const distance = Math.abs(x - listener),
    attenuation = distance <= 96 ? 1 : Math.max(0, 1 - (distance - 96) / (range - 96));
  return {
    attenuation: attenuation * attenuation,
    pan: Math.max(-0.8, Math.min(0.8, (x - listener) / 240)),
  };
}
/** Cosmetic variation uses event identity and never consumes the authoritative random stream. */
export function sfxVariation(id: string, profile: SfxProfile) {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return {
    file: profile.files[hash % profile.files.length] ?? "",
    gain: profile.gain[0] + ((profile.gain[1] - profile.gain[0]) * ((hash >>> 8) & 255)) / 255,
    rate: profile.rate[0] + ((profile.rate[1] - profile.rate[0]) * ((hash >>> 16) & 255)) / 255,
  };
}

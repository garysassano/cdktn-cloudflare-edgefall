import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonical } from "../src/game/core/canonical.js";
import { Held } from "../src/game/input/types.js";
import { type CombatLab, createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import type { BreakwaterMission } from "../src/game/missions/breakwater.js";
import { breakwaterAudioCues } from "../src/shared/animation/breakwater.js";
import { combatAudioCues, combatAudioLoops } from "../src/shared/animation/combat-audio.js";
import {
  COMBAT_AUDIO,
  SFX_PROFILES,
  type VoiceIntent,
  admitSfx,
  sfxSpatial,
  sfxVariation,
} from "../src/shared/animation/sfx-profile.js";
import { runBreakwaterProof } from "./fixtures/breakwater-proof.js";
import { recordTankCombat, tankDamageInput } from "./fixtures/tank-proof.js";

const input = (held = 0, interactPressed = false) => ({
  held,
  jumpPressed: false,
  firePressed: !!(held & Held.Fire),
  grenadePressed: false,
  interactPressed,
});
function seatedTank() {
  let world = createCombatLab("tank", 4);
  for (let tick = 1; tick <= 15; tick++)
    world = stepCombatLab(
      world,
      world.players.map(() => input(0, tick === 1)),
    );
  return world;
}
function burningPlayers() {
  const world = createCombatLab("flame", 4);
  return stepCombatLab(
    world,
    world.players.map(() => input(Held.Fire)),
  );
}

describe("recorded interaction audio", () => {
  it("keeps the engineering launcher silent at release instead of confirming it as a sidearm", () => {
    const before = createCombatLab("rocket");
    const next = stepCombatLab(before, [input(Held.Fire)]);
    expect(
      next.events.some((event) => event.kind === "shot" && event.source?.definitionId === 17),
    ).toBe(true);
    expect(combatAudioCues(before, next)).toEqual([]);
  });

  it("covers every preload variant with a distinct checked-in export and declared loop policy", () => {
    const metadata = JSON.parse(
        readFileSync("public/assets/audio/sfx/breakwater-sfx.json", "utf8"),
      ),
      files = new Set(Object.values(SFX_PROFILES).flatMap((p) => p.files));
    expect([...files].sort()).toEqual(
      metadata.clips.map((c: { file: string }) => c.file.replace("assets/audio/", "")).sort(),
    );
    expect(new Set(metadata.clips.map((c: { sha256: string }) => c.sha256)).size).toBe(
      metadata.clips.length,
    );
    expect(
      metadata.clips
        .filter((c: { loop: boolean }) => c.loop)
        .map((c: { id: string }) => c.id)
        .sort(),
    ).toEqual(["engine-loop", "flame-loop"]);
    expect(COMBAT_AUDIO["boss-warning"].priority).toBeGreaterThan(COMBAT_AUDIO.hmg.priority);
    expect(COMBAT_AUDIO.death.priority).toBeGreaterThan(COMBAT_AUDIO["impact-metal"].priority);
  });

  it("keeps repeated cue variation stable without depending on the global random stream", () => {
    const a = sfxVariation("1:event:3:40:1:shot:none", COMBAT_AUDIO.hmg);
    expect(sfxVariation("1:event:3:40:1:shot:none", COMBAT_AUDIO.hmg)).toEqual(a);
    const variants = new Set(
      Array.from({ length: 100 }, (_, i) => sfxVariation(`hmg:${i}`, COMBAT_AUDIO.hmg).file),
    );
    expect(variants.size).toBe(3);
    expect(sfxSpatial(3000, 192, 512).attenuation).toBe(0);
    expect(sfxSpatial(192, 192, 512)).toEqual({ attenuation: 1, pan: 0 });
  });

  it("replaces the quietest low-priority engine to admit a warning into a full mixed budget", () => {
    const voices: VoiceIntent[] = Array.from({ length: 32 }, (_, i) => ({
      id: String(i),
      kind: i < 4 ? "engine" : i < 8 ? "flame" : i < 20 ? "hmg" : "impact-metal",
      level: i === 2 ? 0.01 : 0.2,
      started: i / 1000,
    }));
    expect(
      admitSfx(voices, { id: "warning", kind: "boss-warning", level: 0.5, started: 1 }),
    ).toEqual({ accepted: true, replace: "2" });
    expect(admitSfx(voices, { id: "far-step", kind: "step", level: 0.1, started: 1 })).toEqual({
      accepted: false,
      reason: "priority",
    });
  });

  it("caps automatic transients and persistent loops without stealing higher-priority cues", () => {
    const hmg: VoiceIntent[] = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      kind: "hmg",
      level: 0.3,
      started: i,
    }));
    expect(admitSfx(hmg, { id: "next", kind: "hmg", level: 0.3, started: 20 })).toEqual({
      accepted: true,
      replace: "0",
    });
    const loops: VoiceIntent[] = Array.from({ length: 8 }, (_, i) => ({
      id: String(i),
      kind: i < 4 ? "engine" : "flame",
      level: 0.2,
      started: 0,
    }));
    expect(admitSfx(loops, { id: "equal", kind: "engine", level: 0.2, started: 1 }).accepted).toBe(
      false,
    );
    expect(admitSfx(loops, { id: "nearer", kind: "engine", level: 0.3, started: 1 })).toEqual({
      accepted: true,
      replace: "0",
    });
    expect(admitSfx([], { id: "far", kind: "engine", level: 0, started: 1 })).toEqual({
      accepted: false,
      reason: "inaudible",
    });
  });

  it("reconstructs four occupied engines and stops each on exit, disconnect, death and epoch loss", () => {
    const world = seatedTank(),
      original = canonical(world);
    expect(combatAudioLoops(world)).toHaveLength(4);
    expect(combatAudioLoops(structuredClone(world))).toEqual(combatAudioLoops(world));
    expect(
      combatAudioLoops(world, new Set(world.players.slice(0, 1).map((p) => p.playerId))),
    ).toHaveLength(3);
    for (const change of [
      (w: CombatLab) => {
        const t = w.tanks[0];
        if (t) t.lifecycle = "exiting";
      },
      (w: CombatLab) => {
        const t = w.tanks[0];
        if (t) t.disconnectedTicks = 1;
      },
      (w: CombatLab) => {
        const t = w.tanks[0];
        if (t) t.armor = 0;
      },
      (w: CombatLab) => {
        const p = w.players[0];
        if (p) p.life = "death";
      },
      (w: CombatLab) => {
        const p = w.players[0];
        if (p) p.controlEpoch++;
      },
    ]) {
      const next = structuredClone(world);
      change(next);
      expect(combatAudioLoops(next)).toHaveLength(3);
    }
    expect(canonical(world)).toBe(original);
  });

  it("uses attached accepted flame emissions, stopping on cancellation, death or weapon replacement", () => {
    const world = burningPlayers();
    expect(combatAudioLoops(world).map((l) => l.kind)).toEqual([
      "flame",
      "flame",
      "flame",
      "flame",
    ]);
    for (const change of [
      (w: CombatLab) => {
        for (const a of w.areas) a.cancelledTick = w.tick;
      },
      (w: CombatLab) => {
        for (const p of w.players) p.life = "death";
      },
      (w: CombatLab) => {
        for (const p of w.players) p.weapon.id = "sidearm";
      },
      (w: CombatLab) => {
        w.tick += 30;
      },
    ]) {
      const next = structuredClone(world);
      change(next);
      expect(combatAudioLoops(next)).toEqual([]);
    }
    expect(combatAudioLoops(world, new Set(world.players.map((p) => p.playerId)))).toEqual([]);
  });

  it("emits one ignition per continuous flame emitter, with a separate tail after emission stops", () => {
    let world = createCombatLab("flame", 4);
    const counts = new Map<string, number>();
    for (let tick = 1; tick <= 30; tick++) {
      const next = stepCombatLab(
        world,
        world.players.map(() => input(tick === 1 ? Held.Fire : 0)),
      );
      for (const cue of combatAudioCues(world, next))
        counts.set(cue.kind, (counts.get(cue.kind) ?? 0) + 1);
      world = next;
    }
    expect(counts.get("flame-ignite")).toBe(4);
    expect(counts.get("flame-tail")).toBe(4);
  });

  it("plays forced ejection and vehicle destruction at the real armor-loss boundary", () => {
    const run = recordTankCombat(196, tankDamageInput),
      before = run.states[182]?.combat,
      next = run.states[183]?.combat;
    if (!before || !next) throw new Error("Missing ejection fixture");
    const kinds = combatAudioCues(before, next).map((cue) => cue.kind);
    expect(kinds).toContain("eject");
    expect(kinds).toContain("tank-destroyed");
    expect(kinds).toContain("engine-stop");
    expect(kinds).not.toContain("death");
    expect(combatAudioLoops(next)).toHaveLength(3);
  });

  it("keeps complete mission state unchanged while distinguishing boss, pickup, boarding and weapon sounds", () => {
    let previous: BreakwaterMission | undefined;
    const kinds = new Set<string>(),
      warnings: number[] = [];
    const proof = runBreakwaterProof((next) => {
      const original = canonical(next);
      if (previous) {
        const cues = breakwaterAudioCues(previous, next);
        expect(new Set(cues.map((c) => c.id)).size).toBe(cues.length);
        for (const cue of cues) {
          kinds.add(cue.kind);
          if (cue.kind === "boss-warning") warnings.push(next.combat.tick);
        }
        for (const loop of combatAudioLoops(next.combat))
          expect(Number.isFinite(loop.rate)).toBe(true);
      }
      expect(canonical(next)).toBe(original);
      previous = next;
    });
    expect(proof.state.phase).toBe("victory");
    for (const kind of [
      "sidearm",
      "hmg",
      "shotgun",
      "flame-ignite",
      "flame-tail",
      "tank",
      "tank-land",
      "engine-start",
      "engine-stop",
      "board",
      "eject",
      "tank-destroyed",
      "pickup",
      "checkpoint",
      "boss-warning",
      "boss-fire",
      "boss-hit",
      "boss-destroyed",
      "victory",
    ])
      expect(kinds.has(kind), kind).toBe(true);
    expect(kinds.has("exit")).toBe(false);
    expect(warnings.length).toBeGreaterThan(2);
    expect(warnings[0]).toBeLessThan(proof.state.combat.tick);
  });
});

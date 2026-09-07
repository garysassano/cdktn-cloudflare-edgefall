import { describe, expect, it } from "vitest";
import { canonical } from "../src/game/core/canonical.js";
import { validateCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import { combatPeerContext } from "../src/shared/diagnostics/combat-workload.js";
import { AREA_EXPOSURE_BYTES, combatRecordBytes } from "../src/shared/protocol/combat-record.js";
import { decodeSnapshot, encodeSnapshot } from "../src/shared/protocol/snapshot.js";
import type { CombatSnapshot } from "../src/shared/protocol/snapshot-schema.js";
import { areaCombatProof, recordAreaCombat } from "./fixtures/area-proof.js";

describe("area exposure wire and private continuation", () => {
  it("rejects a second damage ledger for the same charge and an altered action start", () => {
    const fixture = recordAreaCombat("flame"),
      state = structuredClone(fixture.states[12]);
    if (!state?.combat.areas[0]) throw new Error("Missing area charge");
    const duplicate = structuredClone(state);
    duplicate.combat.areas.push({
      ...structuredClone(state.combat.areas[0]),
      id: duplicate.combat.nextEntityId++,
    });
    expect(() => validateCombatCheckpoint(duplicate)).toThrow(/duplicate area action/);
    state.combat.areas[0].startTick++;
    expect(() => validateCombatCheckpoint(state)).toThrow(/area action start/);
    const snapshot = structuredClone(fixture.states[13]?.snapshot);
    if (!snapshot?.combat?.volumes[0]) throw new Error("Missing public charge");
    snapshot.combat.volumes.push({
      ...snapshot.combat.volumes[0],
      id: snapshot.combat.nextEntityId++,
    });
    expect(() => encodeSnapshot(snapshot, combatPeerContext(snapshot, 0))).toThrow(
      /duplicate area action/,
    );
  });

  it("recovers admitted four-player charge, damage and expiry boundaries exactly", async () => {
    const proof = await areaCombatProof();
    expect(proof.scenarios.map((scenario) => scenario.duplicates)).toEqual([480, 480]);
    expect(proof.scenarios.map((scenario) => scenario.checkpoints.length)).toEqual([5, 10]);
  });
  it("encodes exact 48-byte clipped rectangles and rejects malformed public ownership, order and geometry", () => {
    const state = recordAreaCombat("flame").states[13];
    if (!state?.snapshot.combat) throw new Error("Missing lobe checkpoint");
    const snapshot = state.snapshot,
      context = combatPeerContext(snapshot, 0),
      combat = snapshot.combat;
    expect(combat).not.toBeNull();
    if (!combat) throw new Error("Missing public combat state");
    expect(combatRecordBytes(combat) - combatRecordBytes({ ...combat, volumes: [] })).toBe(
      combat.volumes.length * AREA_EXPOSURE_BYTES,
    );
    expect(canonical(decodeSnapshot(encodeSnapshot(snapshot, context), context))).toEqual(
      canonical(snapshot),
    );
    expect(decodeSnapshot(encodeSnapshot(snapshot, context), context).combat?.volumes).toEqual(
      combat.volumes,
    );
    const mutations: Array<(value: CombatSnapshot) => void> = [
      (value) => {
        value.volumes.reverse();
      },
      (value) => {
        if (value.volumes[0]) value.volumes[0].ownerId = 99;
      },
      (value) => {
        if (value.volumes[0]) value.volumes[0].id = 20;
      },
      (value) => {
        if (value.volumes[0]) value.volumes[0].endTick = 13;
      },
      (value) => {
        if (value.volumes[0]) value.volumes[0].spawnTick = 14;
      },
      (value) => {
        if (value.volumes[0]) value.volumes[0].rect.w = 0;
      },
      (value) => {
        if (value.volumes[0]) value.volumes[0].lobe = 4;
      },
      (value) => {
        if (value.volumes[1]) value.volumes[1].actionInstanceId++;
      },
      (value) => {
        if (value.volumes[0]) value.volumes = Array(65).fill(value.volumes[0]);
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(snapshot);
      if (!changed.combat) throw new Error("Missing changed combat");
      mutate(changed.combat);
      expect(() => encodeSnapshot(changed, context)).toThrow();
    }
    const bytes = encodeSnapshot(snapshot, context);
    // Attachment flag is the last u16 of each independent 48-byte record.
    const bad = bytes.slice();
    bad[bad.length - 2] = 2;
    expect(() => decodeSnapshot(bad, context)).toThrow(/attachment/);
  });
  it("rejects stale attached sockets, reused entities and private hit/emission history corruption", () => {
    const state = recordAreaCombat("flame").states[13];
    if (!state) throw new Error("Missing flame boundary");
    validateCombatCheckpoint(state);
    const changes = [
      (value: typeof state) => {
        if (value.combat.areas[0]) value.combat.areas[0].emitted--;
      },
      (value: typeof state) => {
        const lobe = value.combat.areas[0]?.lobes[2];
        if (lobe) lobe.origin.x++;
      },
      (value: typeof state) => {
        if (value.combat.areas[0]) value.combat.areas[0].id = 21;
      },
      (value: typeof state) => {
        if (value.combat.areas[0]) value.combat.areas[0].cancelledTick = 13;
      },
      (value: typeof state) => {
        if (value.combat.areas[0]) value.combat.areas[0].hits = [{ entityId: 999, nextTick: 19 }];
      },
    ];
    for (const mutate of changes) {
      const altered = structuredClone(state);
      mutate(altered);
      expect(() => validateCombatCheckpoint(altered)).toThrow();
    }
  });
});

import { DurableObject } from "cloudflare:workers";
import { canonical } from "../../src/game/core/canonical.js";
import { transitionCombatRuntime } from "../../src/shared/diagnostics/combat-recovery.js";
import { combatRuntimeHash } from "../../src/shared/diagnostics/combat-runtime.js";
import { roomWorkloadHash } from "../../src/shared/diagnostics/room-workload.js";
import { CombatStorage } from "../../src/worker/diagnostics/combat-storage.js";
import { recordCombatInputs } from "./combat-input-driver.js";
import { combatArchiveIdentity, recordCombatRecovery } from "./combat-recovery-proof.js";
import { recordPlayerLifeRecovery } from "./player-life-recovery-proof.js";
import { recordRifleRecovery } from "./rifle-proof.js";

interface Env {
  STORES: DurableObjectNamespace<CombatStorageProof>;
}
/** Only bundled by the owned local storage verifier; never part of the deployed Worker. */
export class CombatStorageProof extends DurableObject<Env> {
  private readonly instance = crypto.randomUUID();
  private inject = false;
  private readonly archive = combatArchiveIdentity().then(
    (identity) =>
      new CombatStorage(this.ctx.storage, identity, () => {
        if (this.inject) {
          this.inject = false;
          throw new Error("injected-storage-transaction-failure");
        }
      }),
  );
  async fetch(request: Request): Promise<Response> {
    const store = await this.archive;
    const [, name, action] = new URL(request.url).pathname.split("/");
    if (name === "rifle") {
      if (action === "seed" || action === "resume") {
        const fixture = recordRifleRecovery();
        let saved = action === "seed" ? fixture.states[28] : await store.load();
        if (!saved || canonical(saved) !== canonical(fixture.states[saved.combat.tick]))
          throw new Error("Rifle storage prefix mismatch");
        if (action === "seed") await store.initialize(saved);
        const through = action === "seed" ? 30 : 150;
        while (saved.combat.tick < through) {
          const end = Math.min(through, saved.combat.tick + 15);
          const accepted = fixture.states[end];
          if (!accepted) throw new Error("Missing rifle committed boundary");
          const entries = fixture.entries.slice(saved.combat.tick, end);
          this.inject = true;
          let rolledBack = false;
          try {
            await store.commit(saved, entries, accepted);
          } catch (error) {
            rolledBack = String(error).includes("injected-storage-transaction-failure");
          }
          if (!rolledBack || canonical(await store.load()) !== canonical(saved))
            throw new Error("Rifle rollback changed private continuation");
          saved = await store.commit(saved, entries, accepted);
        }
      }
      const saved = await store.load();
      if (!saved) throw new Error("Missing rifle archive");
      return Response.json({
        instance: this.instance,
        tick: saved.combat.tick,
        hash: combatRuntimeHash(saved),
        rifles: saved.combat.targets.map((target) => target.rifle),
        players: saved.combat.players.map(({ life, lives, invulnerableTicks }) => ({
          life,
          lives,
          invulnerableTicks,
        })),
        events: saved.history.entries,
        projectiles: saved.combat.projectiles,
      });
    }
    let loadingChecks: string[] | null = null;
    let phaseChecks: string[] | null = null;
    let campaignChecks: string[] | null = null;
    if (action === "seed-campaign") {
      const wipe = recordPlayerLifeRecovery().states.at(-1);
      if (wipe?.campaign.state.phase !== "wipe") throw new Error("Missing actual party wipe");
      await store.initialize(wipe);
    }
    if (action && ["failed-continue", "denied-continue", "stale-continue"].includes(action)) {
      const saved = await store.load();
      const previous =
        action === "stale-continue" ? recordPlayerLifeRecovery().states.at(-1) : saved;
      if (!saved || !previous) throw new Error("Missing campaign checkpoint");
      this.inject = action === "failed-continue";
      let currentHost = true;
      let guardCalls = 0;
      const pending = store.transition(previous, "continue", () => {
        guardCalls++;
        if (!currentHost) throw new Error("stale-host-command");
      });
      if (action === "denied-continue") currentHost = false;
      let failure = "";
      try {
        await pending;
      } catch (error) {
        failure = String(error);
      }
      const expected =
        action === "failed-continue"
          ? "injected-storage-transaction-failure"
          : action === "denied-continue"
            ? "stale-host-command"
            : "prefix";
      if (!failure.includes(expected) || canonical(await store.load()) !== canonical(saved))
        throw new Error(`Continue rejection changed the saved checkpoint: ${failure}`);
      if (action === "denied-continue" && guardCalls !== 1)
        throw new Error("Missing commit host fence");
      campaignChecks = [action, "archive-unchanged"];
    }
    if (action === "continue" || action === "lost-continue") {
      const previous = await store.load();
      if (!previous) throw new Error("Missing campaign checkpoint");
      await store.transition(previous, "continue");
      if (action === "lost-continue")
        return new Response("Injected response loss after confirmed commit", { status: 503 });
    }
    if (action === "start-continued") {
      const previous = await store.load();
      if (!previous) throw new Error("Missing continued checkpoint");
      const started = await store.transition(previous, "start");
      const replay = recordCombatInputs(started, 15);
      await store.commit(started, replay.entries, replay.state);
    }
    if (action === "seed-life" || action === "resume-life") {
      const fixture = recordPlayerLifeRecovery();
      let state = action === "seed-life" ? fixture.states[fixture.death + 6] : await store.load();
      if (!state) throw new Error("Missing life checkpoint fixture");
      if (action === "seed-life") await store.initialize(state);
      const through = action === "seed-life" ? fixture.death + 21 : fixture.entry + 6;
      const accepted = fixture.states[through];
      if (!accepted || canonical(state) !== canonical(fixture.states[state.combat.tick]))
        throw new Error("Life checkpoint prefix mismatch");
      const entries = fixture.entries.slice(state.combat.tick, through);
      this.inject = true;
      let rolledBack = false;
      try {
        await store.commit(state, entries, accepted);
      } catch {
        rolledBack = true;
      }
      if (!rolledBack || canonical(await store.load()) !== canonical(state))
        throw new Error("Life transaction changed spent lives after rollback");
      state = await store.commit(state, entries, accepted);
      if (canonical(state) !== canonical(accepted))
        throw new Error("Life storage continuation differs from authority");
    }
    if (action === "seed-phase") {
      const phase = name?.replace("phase-", "");
      if (phase !== "lobby" && phase !== "intermission" && phase !== "completed")
        throw new Error("Invalid phase fixture");
      const state = recordCombatRecovery().states[phase === "lobby" ? 0 : 45];
      if (!state) throw new Error("Missing phase fixture");
      state.snapshot.roomMode = phase;
      state.snapshot.stateHash = roomWorkloadHash(state.snapshot);
      state.connectedPlayerIds = [];
      await store.initialize(state);
    }
    if (action === "denied-load") {
      const previous = await store.load();
      if (!previous) throw new Error("Missing phase checkpoint");
      let currentHost = true;
      let guardCalls = 0;
      const pending = store.transition(previous, "load", () => {
        guardCalls++;
        if (!currentHost) throw new Error("stale-host-command");
      });
      // Change the fence after submission while the checkpoint digest is pending.
      currentHost = false;
      let rejected = false;
      try {
        await pending;
      } catch (error) {
        rejected = error instanceof Error && error.message === "stale-host-command";
      }
      if (!rejected || guardCalls !== 1 || canonical(await store.load()) !== canonical(previous))
        throw new Error("Changed host fence reached the saved boundary");
      phaseChecks = ["host-changed-during-checkpoint-encoding", "archive-unchanged"];
    }
    if (action === "phase-recover" || action === "phase-load" || action === "phase-start") {
      const previous = await store.load();
      if (!previous) throw new Error("Missing phase checkpoint");
      const kind =
        action === "phase-recover" ? "recover" : action === "phase-load" ? "load" : "start";
      let guardCalls = 0;
      await store.transition(previous, kind, () => {
        guardCalls++;
      });
      if (guardCalls !== 1) throw new Error("Missing phase transition fence");
      phaseChecks = ["guarded-checkpoint-confirmed"];
    }
    if (action === "denied-terminal") {
      const previous = await store.load();
      if (previous?.snapshot.roomMode !== "completed")
        throw new Error("Missing completed checkpoint");
      phaseChecks = [];
      for (const kind of ["load", "start", "recover", "pause"] as const) {
        let rejected = false;
        try {
          await store.transition(previous, kind);
        } catch {
          rejected = true;
        }
        if (!rejected || canonical(await store.load()) !== canonical(previous))
          throw new Error("Terminal room was resumed");
        phaseChecks.push(`${kind}-rejected`);
      }
    }
    if (action === "seed-loading") {
      const state = recordCombatRecovery().states[45];
      if (!state) throw new Error("Missing loading fixture");
      await store.initialize(transitionCombatRuntime(state, "recover"));
    }
    if (action === "replace-loading" || action === "replace-waiting") {
      const previous = await store.load();
      if (!previous) throw new Error("Missing loading checkpoint");
      this.inject = true;
      let failed = false;
      try {
        await store.replaceWaitingConnection(previous, 2);
      } catch {
        failed = true;
      }
      if (!failed || canonical(await store.load()) !== canonical(previous))
        throw new Error("Loading replacement did not roll back");
      const replaced = await store.replaceWaitingConnection(previous, 2);
      let staleRejected = false;
      try {
        await store.replaceWaitingConnection(previous, 3);
      } catch {
        staleRejected = true;
      }
      if (!staleRejected || canonical(await store.load()) !== canonical(replaced))
        throw new Error("Stale replacement overwrote the saved boundary");
      loadingChecks = ["sql-rollback", "changed-prefix-rejected"];
    }
    if (action === "seed-tail") {
      const { states, entries } = recordCombatRecovery();
      let state = states[0];
      if (!state) throw new Error("Missing tail fixture");
      await store.initialize(state);
      for (const [from, through] of [
        [0, 15],
        [15, 30],
        [30, 45],
        [45, 59],
      ] as const) {
        const accepted = states[through];
        if (!accepted) throw new Error("Missing tail boundary");
        state = await store.commit(state, entries.slice(from, through), accepted);
      }
    }
    if (action === "pause-tail" || action === "expire-tail") {
      const previous = await store.load();
      if (!previous) throw new Error("Missing stored tail");
      const kind = action === "pause-tail" ? "pause" : "expire";
      this.inject = true;
      let failed = false;
      try {
        await store.transition(previous, kind);
      } catch {
        failed = true;
      }
      if (!failed || canonical(await store.load()) !== canonical(previous))
        throw new Error("Lifecycle checkpoint did not roll back");
      await store.transition(previous, kind);
    }
    if (action === "resurrect") {
      const previous = await store.load();
      if (!previous) throw new Error("Missing expired state");
      let rejected = false;
      try {
        await store.transition(previous, "recover");
      } catch {
        rejected = true;
      }
      if (!rejected || canonical(await store.load()) !== canonical(previous))
        throw new Error("Expired room was resurrected");
    }
    if (action === "seed") {
      const { states, entries } = recordCombatRecovery();
      let state = states[0];
      if (!state) throw new Error("Missing initial fixture");
      await store.initialize(state);
      let rollbackTick: number | null = null;
      const rollbackTicks: number[] = [];
      for (let start = 0; start < 105; start += 15) {
        const segment = entries.slice(start, start + 15);
        const accepted = states[start + 15];
        if (!accepted) throw new Error("Missing accepted fixture");
        if (start === 45 || start === 90) {
          this.inject = true;
          let failed = false;
          try {
            await store.commit(state, segment, accepted);
          } catch {
            failed = true;
          }
          const restored = await store.load();
          if (!failed || !restored || canonical(restored) !== canonical(state))
            throw new Error("SQL transaction did not roll back");
          rollbackTick = restored.combat.tick;
          rollbackTicks.push(rollbackTick);
        }
        state = await store.commit(state, segment, accepted);
      }
      if (canonical(state) !== canonical(states[105]))
        throw new Error("Stored input replay differs from authority");
      return Response.json({
        instance: this.instance,
        tick: state.combat.tick,
        observedTick: 119,
        rollbackTick,
        rollbackTicks,
        hash: combatRuntimeHash(state),
      });
    }
    if (action === "gap")
      this.ctx.storage.sql.exec("DELETE FROM combat_archive WHERE key = ?", "segment:76");
    try {
      const state = await store.load();
      return Response.json({
        instance: this.instance,
        tick: state?.combat.tick,
        roomMode: state?.snapshot.roomMode,
        pausedFrom: state?.pausedFrom,
        runEpoch: state?.snapshot.runEpoch,
        connections: state?.snapshot.acknowledgments.map((ack) => ({
          playerId: ack.playerId,
          connectionEpoch: ack.connectionEpoch,
          controlEpoch: ack.controlEpoch,
          lastProcessedSequence: ack.lastProcessedSequence,
        })),
        loadingChecks,
        phaseChecks,
        campaignChecks,
        campaign: state?.campaign,
        targets: state?.combat.targets.map((target) => target.enemy.body.id),
        encounter: state?.combat.encounter,
        hash: state && combatRuntimeHash(state),
        nextActionId: state?.combat.nextActionId,
        nextEntityId: state?.combat.nextEntityId,
        eventCursor: state?.history.cursor,
        kills: state?.combat.encounter.kills,
        lives: state?.combat.players.map((player) => ({
          playerId: player.playerId,
          life: player.life,
          lifeStartTick: player.lifeStartTick,
          lives: player.lives,
          invulnerableTicks: player.invulnerableTicks,
          weapon: player.weapon,
        })),
        rows: this.ctx.storage.sql
          .exec(
            "SELECT key, run_epoch, tick, length(payload) AS bytes FROM combat_archive ORDER BY tick, key",
          )
          .toArray(),
      });
    } catch (error) {
      return Response.json(
        { instance: this.instance, rejected: true, reason: String(error) },
        { status: 409 },
      );
    }
  }
}
export default {
  fetch(request: Request, env: Env) {
    const name = new URL(request.url).pathname.split("/")[1];
    if (
      !name ||
      ![
        "proof",
        "tail",
        "loading",
        "life",
        "rifle",
        "campaign",
        "campaign-loss",
        "phase-lobby",
        "phase-intermission",
        "phase-completed",
      ].includes(name)
    )
      return new Response("Not found", { status: 404 });
    return env.STORES.get(env.STORES.idFromName(name)).fetch(request);
  },
};

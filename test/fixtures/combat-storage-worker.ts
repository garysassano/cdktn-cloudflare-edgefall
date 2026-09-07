import { DurableObject } from "cloudflare:workers";
import { canonical } from "../../src/game/core/canonical.js";
import { combatRuntimeHash } from "../../src/shared/diagnostics/combat-runtime.js";
import { CombatStorage } from "../../src/worker/diagnostics/combat-storage.js";
import { combatArchiveIdentity, recordCombatRecovery } from "./combat-recovery-proof.js";

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
    const action = new URL(request.url).pathname.split("/")[2];
    if (action === "seed") {
      const { states, entries } = recordCombatRecovery();
      let state = states[0];
      if (!state) throw new Error("Missing initial fixture");
      await store.initialize(state);
      let rollbackTick: number | null = null;
      const rollbackTicks: number[] = [];
      for (let start = 0; start < 105; start += 15) {
        const segment = entries.slice(start, start + 15);
        if (start === 45 || start === 90) {
          this.inject = true;
          let failed = false;
          try {
            await store.commit(state, segment);
          } catch {
            failed = true;
          }
          const restored = await store.load();
          if (!failed || !restored || canonical(restored) !== canonical(state))
            throw new Error("SQL transaction did not roll back");
          rollbackTick = restored.combat.tick;
          rollbackTicks.push(rollbackTick);
        }
        state = await store.commit(state, segment);
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
        hash: state && combatRuntimeHash(state),
        nextActionId: state?.combat.nextActionId,
        nextEntityId: state?.combat.nextEntityId,
        eventCursor: state?.history.cursor,
        kills: state?.combat.encounter.kills,
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
    if (name !== "proof") return new Response("Not found", { status: 404 });
    return env.STORES.get(env.STORES.idFromName(name)).fetch(request);
  },
};

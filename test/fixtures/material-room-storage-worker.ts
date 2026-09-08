import { DurableObject } from "cloudflare:workers";
import { canonical } from "../../src/game/core/canonical.js";
import { CombatStorage } from "../../src/worker/diagnostics/combat-storage.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";
import { materialRoomContract } from "./material-room-contract.js";
import {
  MATERIAL_ROOM_CASES,
  MATERIAL_ROOM_STORAGE_BOUNDARIES,
  recordMaterialRoom,
} from "./material-room-proof.js";

interface Env {
  STORES: DurableObjectNamespace<MaterialRoomStorageProof>;
}

/** Owned local verifier only. Never included in the application Worker. */
export class MaterialRoomStorageProof extends DurableObject<Env> {
  private readonly instance = crypto.randomUUID();
  private inject = false;
  private readonly archive = combatArchiveIdentity().then(
    (identity) =>
      new CombatStorage(this.ctx.storage, identity, () => {
        if (this.inject) {
          this.inject = false;
          throw new Error("injected-material-transaction-failure");
        }
      }),
  );

  async fetch(request: Request): Promise<Response> {
    const [, , index, action] = new URL(request.url).pathname.split("/"),
      definition = MATERIAL_ROOM_CASES[Number(index)],
      store = await this.archive;
    if (!definition) return new Response("Unknown material case", { status: 400 });
    let rollbackChecks = 0;
    const rows = () =>
      this.ctx.storage.sql.exec("SELECT * FROM combat_archive ORDER BY key").toArray();
    const beforeFailure = async (operation: () => Promise<unknown>) => {
      const original = canonical(rows());
      this.inject = true;
      let rejected = false;
      try {
        await operation();
      } catch (error) {
        rejected = String(error).includes("injected-material-transaction-failure");
      }
      if (!rejected || canonical(rows()) !== original)
        throw new Error("Material failure changed durable rows");
      rollbackChecks++;
    };
    if (action !== "restore") {
      const through = Number(action);
      if (!MATERIAL_ROOM_STORAGE_BOUNDARIES.includes(through))
        return new Response("Unknown material storage boundary", { status: 400 });
      const fixture = recordMaterialRoom(definition);
      let saved = await store.load();
      if (!saved) {
        if (through !== 0) throw new Error("Missing material seed");
        const initial = fixture.states[0];
        if (!initial) throw new Error("Missing material baseline");
        await beforeFailure(() => store.initialize(initial));
        if ((await store.load()) !== null)
          throw new Error("Failed seed left durable material state");
        await store.initialize(initial);
        saved = initial;
      }
      if (canonical(saved) !== canonical(fixture.states[saved.combat.tick]))
        throw new Error("Material durable prefix differs from admitted input");
      while (saved.combat.tick < through) {
        const previous = saved,
          end = Math.min(through, previous.combat.tick + 15),
          accepted = fixture.states[end],
          entries = fixture.entries.slice(previous.combat.tick, end);
        if (!accepted) throw new Error("Missing accepted material boundary");
        await beforeFailure(() => store.commit(previous, entries, accepted));
        if (canonical(await store.load()) !== canonical(previous))
          throw new Error("Failed material transaction changed private continuation");
        saved = await store.commit(previous, entries, accepted);
      }
    }
    const state = await store.load();
    if (!state) throw new Error("Missing material archive");
    return Response.json({
      instance: this.instance,
      rollbackChecks,
      state,
      rows: rows().map((row) => ({ key: row.key, tick: row.tick, runEpoch: row.run_epoch })),
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health") return Response.json({ fixture: "material-room-proof" });
    const proof = /^\/proof\/(1|4)$/u.exec(path);
    if (proof) return Response.json(await materialRoomContract(Number(proof[1])));
    const storage = /^\/storage\/(0|[1-9]\d*)\/(restore|0|[1-9]\d*)$/u.exec(path);
    if (storage && Number(storage[1]) < MATERIAL_ROOM_CASES.length)
      return env.STORES.get(env.STORES.idFromName(`material-${storage[1]}`)).fetch(request);
    return new Response("Unknown material proof route", { status: 404 });
  },
};

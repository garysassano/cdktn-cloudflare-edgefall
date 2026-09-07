import assert from "node:assert/strict";

interface StoredPhase {
  instance: string;
  tick: number;
  roomMode: string;
  pausedFrom: string | null;
  runEpoch: number;
  hash: string;
  nextActionId: number;
  nextEntityId: number;
  kills: Array<{ playerId: number; count: number }>;
  phaseChecks: string[] | null;
  connections: Array<{
    playerId: number;
    connectionEpoch: number;
    controlEpoch: number;
    lastProcessedSequence: number;
  }>;
}

/** Restart actual workerd processes against the same owned SQLite directory at each boundary. */
export async function verifyStoredPhases(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const request = async (phase: string, action: string): Promise<StoredPhase> => {
    const response = await fetch(`${await origin()}/phase-${phase}/${action}`, { method: "POST" });
    assert(response.ok, `Stored ${phase}/${action}: ${await response.clone().text()}`);
    return (await response.json()) as StoredPhase;
  };
  const continuation = (before: StoredPhase, after: StoredPhase) => {
    for (const field of ["tick", "nextActionId", "nextEntityId", "kills"] as const)
      assert.deepEqual(after[field], before[field], `Passive phase changed ${field}`);
  };
  const coldRestore = async (phase: string, before: StoredPhase, action = "restore") => {
    await restart();
    const cold = await request(phase, action);
    assert.notEqual(cold.instance, before.instance);
    assert.equal(cold.hash, before.hash);
    assert.equal(cold.runEpoch, before.runEpoch);
    assert.equal(cold.roomMode, before.roomMode);
    assert.equal(cold.pausedFrom, before.pausedFrom);
    assert.deepEqual(cold.connections, before.connections);
    continuation(before, cold);
    return cold;
  };
  const waiting = [];
  for (const phase of ["lobby", "intermission"] as const) {
    const seeded = await request(phase, "seed-phase");
    assert.equal(seeded.roomMode, phase);
    const denied = await request(phase, "denied-load");
    assert.equal(denied.hash, seeded.hash);
    assert.deepEqual(denied.phaseChecks, [
      "host-changed-during-checkpoint-encoding",
      "archive-unchanged",
    ]);
    const deniedCold = await coldRestore(phase, denied);
    const paused = await request(phase, "pause-tail");
    assert.equal(paused.roomMode, "paused-empty");
    assert.equal(paused.pausedFrom, phase);
    continuation(seeded, paused);
    const pausedCold = await coldRestore(phase, paused);
    const recovered = await request(phase, "phase-recover");
    assert.equal(recovered.roomMode, phase);
    assert.equal(recovered.pausedFrom, null);
    assert.equal(recovered.runEpoch, paused.runEpoch + 1);
    assert.deepEqual(
      recovered.connections,
      paused.connections.map((connection) => ({
        ...connection,
        connectionEpoch: connection.connectionEpoch + 1,
        controlEpoch: connection.controlEpoch + 1,
        lastProcessedSequence: 0,
      })),
    );
    continuation(seeded, recovered);
    const recoveredCold = await coldRestore(phase, recovered);
    const loading = await request(phase, "phase-load");
    assert.equal(loading.roomMode, "loading");
    assert.equal(loading.runEpoch, recovered.runEpoch);
    assert.deepEqual(loading.phaseChecks, ["guarded-checkpoint-confirmed"]);
    continuation(seeded, loading);
    const started = await request(phase, "phase-start");
    assert.equal(started.roomMode, "playing");
    assert.equal(started.runEpoch, loading.runEpoch);
    continuation(seeded, started);
    const startedCold = await coldRestore(phase, started);
    waiting.push({
      phase,
      seeded,
      denied,
      deniedCold,
      paused,
      pausedCold,
      recovered,
      recoveredCold,
      loading,
      started,
      startedCold,
    });
  }
  const seeded = await request("completed", "seed-phase");
  const denied = await request("completed", "denied-terminal");
  assert.equal(denied.hash, seeded.hash);
  assert.deepEqual(denied.phaseChecks, [
    "load-rejected",
    "start-rejected",
    "recover-rejected",
    "pause-rejected",
  ]);
  const cold = await coldRestore("completed", denied);
  const replaced = await request("completed", "replace-waiting");
  continuation(seeded, replaced);
  assert.equal(replaced.roomMode, "completed");
  assert.equal(replaced.runEpoch, seeded.runEpoch);
  assert.deepEqual(
    replaced.connections,
    seeded.connections.map((connection) => ({
      ...connection,
      connectionEpoch: connection.connectionEpoch + (connection.playerId === 2 ? 1 : 0),
      lastProcessedSequence: connection.playerId === 2 ? 0 : connection.lastProcessedSequence,
    })),
  );
  const replacedCold = await coldRestore("completed", replaced);
  const expired = await request("completed", "expire-tail");
  assert.equal(expired.roomMode, "expired");
  continuation(seeded, expired);
  const expiredCold = await coldRestore("completed", expired, "resurrect");
  return {
    waiting,
    completed: { seeded, denied, cold, replaced, replacedCold, expired, expiredCold },
  };
}

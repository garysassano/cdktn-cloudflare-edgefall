import assert from "node:assert/strict";
import type { CombatCampaign } from "../../src/game/labs/combat-campaign.js";
import type { ControlledActor } from "../../src/game/state.js";

interface StoredCampaign {
  instance: string;
  tick: number;
  roomMode: string;
  runEpoch: number;
  hash: string;
  nextActionId: number;
  nextEntityId: number;
  campaign: CombatCampaign;
  targets: number[];
  campaignChecks: string[] | null;
  lives: Array<
    Pick<
      ControlledActor,
      "playerId" | "life" | "lifeStartTick" | "lives" | "invulnerableTicks" | "weapon"
    >
  >;
  encounter: { members: Array<{ status: string }> };
  connections: Array<{
    connectionEpoch: number;
    controlEpoch: number;
    lastProcessedSequence: number;
  }>;
}

/** Actual input-derived wipes and guarded continues in SQLite, including lost commit acknowledgments. */
export async function verifyStoredCampaign(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const request = async (action: string, name = "campaign"): Promise<StoredCampaign> => {
    const response = await fetch(`${await origin()}/${name}/${action}`, { method: "POST" });
    assert(response.ok, `Campaign ${action}: ${await response.clone().text()}`);
    return (await response.json()) as StoredCampaign;
  };
  const cold = async (before: StoredCampaign, name = "campaign") => {
    await restart();
    const restored = await request("restore", name);
    assert.notEqual(restored.instance, before.instance, "SQLite restore reused a workerd instance");
    for (const key of [
      "hash",
      "tick",
      "roomMode",
      "runEpoch",
      "nextActionId",
      "nextEntityId",
      "campaign",
      "targets",
      "lives",
      "connections",
    ] as const)
      assert.deepEqual(restored[key], before[key], `Cold continue changed ${key}`);
    return restored;
  };
  const wipe = await request("seed-campaign");
  assert.equal(wipe.roomMode, "intermission");
  assert.equal(wipe.campaign.state.phase, "wipe");
  assert(wipe.lives.every((player) => player.life === "spectating" && player.lives === 0));
  const rolledBack = await request("failed-continue");
  assert.equal(rolledBack.hash, wipe.hash);
  assert.deepEqual(rolledBack.campaignChecks, ["failed-continue", "archive-unchanged"]);
  const coldRollback = await cold(rolledBack);
  const denied = await request("denied-continue");
  assert.equal(denied.hash, wipe.hash);
  assert.deepEqual(denied.campaignChecks, ["denied-continue", "archive-unchanged"]);
  const continued = await request("continue");
  assert.equal(continued.tick, wipe.tick);
  assert.equal(continued.roomMode, "loading");
  assert.equal(continued.runEpoch, wipe.runEpoch + 1);
  assert.equal(continued.campaign.state.continuesUsed, 1);
  assert.equal(continued.campaign.state.continuesRemaining, 2);
  assert.equal(continued.campaign.continues.length, 1);
  assert.deepEqual(continued.targets, [wipe.nextEntityId, wipe.nextEntityId + 1]);
  assert.equal(continued.nextActionId, wipe.nextActionId);
  assert(
    continued.lives.every(
      (player, i) =>
        player.life === "respawning" &&
        player.lifeStartTick === wipe.tick &&
        player.lives === 3 &&
        player.invulnerableTicks === 120 &&
        player.weapon.shotOrdinal === wipe.lives[i]?.weapon.shotOrdinal,
    ),
  );
  assert(
    continued.connections.every(
      (connection, i) =>
        connection.connectionEpoch === (wipe.connections[i]?.connectionEpoch ?? NaN) + 1 &&
        connection.controlEpoch === (wipe.connections[i]?.controlEpoch ?? NaN) + 1 &&
        connection.lastProcessedSequence === 0,
    ),
  );
  const stale = await request("stale-continue");
  assert.equal(stale.hash, continued.hash);
  assert.deepEqual(stale.campaignChecks, ["stale-continue", "archive-unchanged"]);
  const coldContinue = await cold(stale);
  const entered = await request("start-continued");
  assert.equal(entered.tick, wipe.tick + 15);
  assert(entered.lives.every((player) => player.life === "alive" && player.lives === 3));
  assert(entered.encounter.members.every((member) => member.status !== "pending"));
  assert.deepEqual(entered.campaign.continues, continued.campaign.continues);
  const coldEntry = await cold(entered);

  const lostWipe = await request("seed-campaign", "campaign-loss");
  const lostResponse = await fetch(`${await origin()}/campaign-loss/lost-continue`, {
    method: "POST",
  });
  assert.equal(lostResponse.status, 503);
  await restart();
  const lostCold = await request("restore", "campaign-loss");
  assert.notEqual(lostCold.instance, lostWipe.instance);
  assert.equal(
    lostCold.hash,
    continued.hash,
    "Lost response must retain the one confirmed continue",
  );
  const lostRetry = await request("stale-continue", "campaign-loss");
  assert.equal(lostRetry.hash, lostCold.hash);
  const recovered = await request("phase-recover", "campaign-loss");
  assert.equal(recovered.runEpoch, lostCold.runEpoch + 1);
  assert.equal(recovered.roomMode, "loading");
  assert.deepEqual(recovered.campaign, lostCold.campaign);
  assert.deepEqual(recovered.targets, lostCold.targets);
  assert.deepEqual(recovered.lives, lostCold.lives);
  const recoveredCold = await cold(recovered, "campaign-loss");
  return {
    wipe,
    rolledBack,
    coldRollback,
    denied,
    continued,
    stale,
    coldContinue,
    entered,
    coldEntry,
    lostAcknowledgment: {
      lostWipe,
      status: lostResponse.status,
      lostCold,
      lostRetry,
      recovered,
      recoveredCold,
    },
  };
}

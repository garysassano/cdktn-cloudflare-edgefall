import assert from "node:assert/strict";

export async function verifyDeathBodyLab(page, read, checkRenderedPixels, checkRecording) {
  const surface = page.locator("#game"),
    cases = [];
  for (const kind of ["rising", "falling"]) {
    await page.locator("#scenario").selectOption("rifle");
    await page.locator("#players").selectOption("1");
    await page.locator("#reset").click();
    await surface.focus();
    if (kind === "rising") await page.keyboard.down("ArrowRight");
    const jumpTick = kind === "rising" ? 35 : 31;
    let deathTick = null,
      landedTick = null,
      prior = null;
    const samples = [];
    for (let tick = 1; tick <= 125; tick++) {
      if (tick === jumpTick) await page.keyboard.press("Space");
      await page.keyboard.press("Enter");
      const value = await read(),
        actor = value.state.players[0],
        frame = value.frames[0];
      assert.equal(value.state.tick, tick);
      if (actor.life === "death") {
        if (deathTick === null) {
          deathTick = tick;
          assert.equal(actor.body.grounded, false);
          assert.equal(actor.body.vy < 0, kind === "rising");
        }
        assert.equal(actor.deathBody, "present");
        assert.equal(actor.lives, 2);
        assert.equal(actor.lifeStartTick, deathTick);
        assert.equal(frame.upperFrame, null);
        assert.equal(frame.legsFrame, null);
        assert.equal(frame.x, Math.round(actor.body.x / 256));
        assert.equal(frame.y, Math.round(actor.body.y / 256));
        if (!actor.body.grounded)
          assert.match(frame.fullBodyFrame, /body-death-(hit|reel|buckle)$/);
        if (tick === deathTick + 1) {
          assert.equal(actor.body.vy, prior.body.vy + 55);
          assert.equal(actor.body.y, prior.body.y + actor.body.vy);
          // The killing tick's debug impact circle intentionally covers sprite pixels.
          // Compare the first subsequent physics tick after that overlay has expired.
          await checkRenderedPixels(`death-${kind}-moving`);
        }
        if (actor.body.grounded && landedTick === null) {
          landedTick = tick;
          assert.equal(actor.body.vx, 0);
          await checkRenderedPixels(`death-${kind}-landed`);
        }
        if (tick === deathTick + 6) {
          await checkRenderedPixels(`death-${kind}-continued`);
          await checkRecording(`death-${kind}-recording.json`);
          if (kind === "rising") await page.keyboard.down("ArrowRight");
        }
      }
      if (deathTick !== null)
        samples.push({
          tick,
          life: actor.life,
          deathBody: actor.deathBody,
          body: actor.body,
          drawing: frame?.fullBodyFrame ?? null,
        });
      prior = actor;
      if (deathTick !== null && tick === deathTick + 30) {
        assert.equal(actor.life, "respawning");
        assert.equal(actor.deathBody, null);
      }
      if (deathTick !== null && tick === deathTick + 42) {
        assert.equal(actor.life, "alive");
        assert.equal(actor.deathBody, null);
        break;
      }
    }
    await page.keyboard.up("ArrowRight");
    assert.equal(deathTick, kind === "rising" ? 39 : 77);
    if (kind === "falling") assert.equal(landedTick, 81);
    cases.push({ kind, deathTick, landedTick, samples });
  }
  await page.locator("#scenario").selectOption("range");
  await surface.focus();
  await page.keyboard.down("ArrowRight");
  let removed = null;
  for (let count = 0; count < 350; count++) {
    await page.keyboard.press("Enter");
    const value = await read();
    if (value.state.players[0].deathBody === "removed") {
      assert.equal(value.frames[0], null);
      removed = value.state.players[0];
      await page.keyboard.up("ArrowRight");
      await checkRecording("death-removed-recording.json");
      break;
    }
  }
  assert(removed, "Real controller fall did not retire its corpse");
  return {
    cases,
    removed,
    scope:
      "Real keyboard jumps, hostile rifle kills, authoritative corpse coordinates, native pixel comparisons, floor settling, void hiding and exact UI recording import",
  };
}

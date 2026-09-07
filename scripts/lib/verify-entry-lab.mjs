import assert from "node:assert/strict";

export async function verifyEntryLab(page, read, checkRenderedPixels, checkRecording) {
  await page.locator("#scenario").selectOption("ordnance");
  await page.locator("#players").selectOption("1");
  await page.locator("#reset").click();
  await page.locator("#game").focus();
  await page.keyboard.down("ArrowRight");
  const samples = [];
  for (let tick = 1; tick <= 113; tick++) {
    if (tick === 51) await page.keyboard.up("ArrowRight");
    if (tick === 105 || tick === 111) {
      await page.keyboard.press("Space");
      await page.keyboard.press("KeyZ");
    }
    await page.keyboard.press("Enter");
    const value = await read(),
      actor = value.state.players[0],
      drawing = value.frames[0];
    assert.equal(value.state.tick, tick);
    if (tick >= 69 && tick < 99) {
      assert.equal(actor.life, "death");
      assert.equal(actor.bodyPresence, "removed");
      assert.equal(drawing, null);
      assert.equal(actor.lives, 2);
    }
    if (tick >= 99 && tick < 111) {
      assert.equal(actor.life, "respawning");
      assert.equal(actor.bodyPresence, "present");
      assert.equal(actor.lifeStartTick, 99);
      assert.equal(actor.body.y, 160 * 256);
      assert.equal(actor.weapon.shotOrdinal, 0);
      assert.match(drawing.fullBodyFrame, /body-reentry-/);
    }
    if ([69, 99, 105, 111].includes(tick)) {
      samples.push({ tick, actor, drawing });
      // The first firing tick draws the newborn projectile over the muzzle.
      // Keep exact state/replay checks here; compare bare sprite pixels at 113.
      if (drawing && tick !== 111) await checkRenderedPixels(`entry-press-${tick}`);
      await checkRecording(`entry-press-${tick}.json`);
    }
    if (tick === 113) await checkRenderedPixels("entry-press-ready-motion");
    if (tick === 111) {
      assert.equal(actor.life, "alive");
      assert.equal(actor.lifeStartTick, 111);
      assert.equal(actor.lives, 2);
      assert.equal(actor.body.vy, -1375);
      assert.equal(actor.weapon.shotOrdinal, 1);
      assert.equal(drawing.fullBodyFrame, null);
    }
  }
  return {
    samples,
    scope:
      "Real browser keyboard walk into the authored press, hidden crushed body, native entry frames, rejected protected input, first-ready jump/fire and four exact recording imports. Initial moving entry is covered separately by portable/SQLite fixtures.",
  };
}

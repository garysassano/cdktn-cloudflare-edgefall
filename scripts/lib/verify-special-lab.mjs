import assert from "node:assert/strict";

export async function verifySpecialLab(page, output) {
  await page.locator("#scenario").selectOption("tank");
  await page.locator("#players").selectOption("1");
  await page.locator("#assist").uncheck();
  await page.locator("#reset").click();
  const read = () => page.evaluate(() => globalThis.combatLab.state()),
    keys = new Set(),
    boundaries = [],
    restoredTicks = [];
  await page.locator("#game").focus();
  for (let tick = 1; tick <= 130; tick++) {
    const wanted = new Set([
      ...(tick === 1 ? ["KeyE"] : []),
      ...((tick >= 13 && tick <= 26) || tick >= 33 ? ["KeyV"] : []),
    ]);
    for (const key of keys)
      if (!wanted.has(key)) {
        await page.keyboard.up(key);
        keys.delete(key);
      }
    for (const key of wanted)
      if (!keys.has(key)) {
        await page.keyboard.down(key);
        keys.add(key);
      }
    await page.keyboard.press("Enter");
    const state = await read();
    assert.equal(state.tick, tick);
    if ([13, 26, 27, 33, 61, 62, 63, 98, 109, 130].includes(tick)) {
      boundaries.push({
        tick,
        tank: state.tanks[0],
        players: state.players,
        shells: state.projectiles.filter((p) => p.definitionId === 19),
        events: state.events,
      });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await page.screenshot({ path: `${output}/special-${tick}.png` });
    }
    if ([26, 27, 61, 62, 98].includes(tick)) {
      for (const key of keys) await page.keyboard.up(key);
      keys.clear();
      const path = `${output}/special-${tick}.json`,
        download = page.waitForEvent("download");
      await page.locator("#export").click();
      await (await download).saveAs(path);
      await page.locator("#reset").click();
      await page.locator("#import").setInputFiles(path);
      await page.waitForFunction(() =>
        document.querySelector("#status").textContent.includes("imported replay matches"),
      );
      assert.deepEqual(await read(), state);
      restoredTicks.push(tick);
      await page.locator("#game").focus();
    }
  }
  const final = await read();
  assert.equal(final.tanks[0].lifecycle, "wreck");
  assert.equal(final.tanks[0].special.phase, "spent");
  assert.equal(final.players[0].vehicleId, null);
  assert.equal(boundaries.find((b) => b.tick === 62).players[0].lives, 3);
  assert.equal(boundaries.find((b) => b.tick === 98).players[0].lives, 3);
  const hit = boundaries.find((b) => b.tick === 109);
  assert(
    hit.events.some(
      (event) =>
        event.kind === "killed" && event.targetId === 1 && event.impact?.definitionId === 3,
    ),
  );
  assert.equal(final.players[0].lives, 2);
  assert.equal(final.players[0].lifeStartTick, 109);
  assert.equal(boundaries.find((b) => b.tick === 27).tank.special.phase, "canceled");
  assert.equal(boundaries.find((b) => b.tick === 61).tank.special.phase, "arming");
  assert.equal(boundaries.find((b) => b.tick === 62).tank.special.commitTick, 62);
  return { boundaries, restoredTicks, final };
}

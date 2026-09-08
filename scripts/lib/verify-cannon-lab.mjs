import assert from "node:assert/strict";

export async function verifyCannonLab(page, output) {
  await page.locator("#scenario").selectOption("tank");
  await page.locator("#players").selectOption("1");
  await page.locator("#assist").uncheck();
  await page.locator("#reset").click();
  const read = () => page.evaluate(() => globalThis.combatLab.state()),
    keys = new Set(),
    boundaries = [],
    restoredTicks = [];
  await page.locator("#game").focus();
  for (let tick = 1; tick <= 175; tick++) {
    const wanted = new Set([
      ...(tick === 1 || tick === 110 ? ["KeyE"] : []),
      ...(tick >= 13 && tick <= 16 ? ["ArrowRight"] : []),
      ...(tick === 18 ? ["Space"] : []),
      ...(tick >= 18 && tick <= 27 ? ["KeyZ"] : []),
      ...([18, 63, 108].includes(tick) ? ["KeyC"] : []),
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
    if ([18, 20, 21, 23, 65, 66, 109, 110, 117].includes(tick)) {
      boundaries.push({
        tick,
        tank: state.tanks[0],
        shells: state.projectiles.filter((p) => p.definitionId === 19),
        events: state.events,
      });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await page.screenshot({ path: `${output}/cannon-${tick}.png` });
    }
    if ([20, 21, 65, 66, 109, 110, 117].includes(tick)) {
      for (const key of keys) await page.keyboard.up(key);
      keys.clear();
      const path = `${output}/cannon-${tick}.json`,
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
  assert.equal(final.tanks[0].secondary.ammo, 7);
  assert.equal(final.tanks[0].secondary.shotsFired, 3);
  assert.equal(final.tanks[0].secondary.action.kind, "ready");
  assert.equal(final.tanks[0].lifecycle, "available");
  assert.equal(final.players[0].lives, 3);
  assert.equal(final.players[0].grenadeStock, 10);
  assert.equal(final.players[0].vehicleId, null);
  assert.equal(boundaries.find((b) => b.tick === 20).shells.length, 0);
  assert.equal(boundaries.find((b) => b.tick === 21).shells.length, 1);
  assert(boundaries.find((b) => b.tick === 117).shells.length > 0);
  return { boundaries, restoredTicks, final };
}

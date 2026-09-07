import assert from "node:assert/strict";

export async function verifyTankLab(page, output) {
  await page.locator("#scenario").selectOption("tank");
  await page.locator("#players").selectOption("1");
  await page.locator("#assist").uncheck();
  await page.locator("#reset").click();
  const read = () => page.evaluate(() => globalThis.combatLab.state());
  const keys = new Set(),
    boundaries = [],
    restoredTicks = [];
  await page.locator("#game").focus();
  for (let tick = 1; tick <= 120; tick++) {
    const wanted = new Set([
      ...(tick === 1 || tick === 90 ? ["KeyE"] : []),
      ...(tick >= 13 && tick <= 26 ? ["ArrowRight"] : []),
      ...(tick >= 15 && tick <= 21 ? ["ArrowUp"] : []),
      ...(tick === 15 ? ["Space"] : []),
      ...(tick >= 60 && tick <= 74 ? ["KeyZ"] : []),
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
    if ([1, 11, 12, 21, 60, 90, 96, 97].includes(tick)) {
      boundaries.push({ tick, tank: state.tanks[0], player: state.players[0] });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await page.screenshot({ path: `${output}/tank-${tick}.png` });
    }
    if ([11, 60, 96].includes(tick)) {
      for (const key of keys) await page.keyboard.up(key);
      keys.clear();
      const path = `${output}/tank-${tick}.json`,
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
  assert.equal(final.encounter.phase, "complete");
  assert.equal(final.players[0].lives, 3);
  assert.equal(final.players[0].vehicleId, null);
  assert.equal(final.players[0].controlEpoch, 5);
  assert.equal(final.tanks[0].lifecycle, "available");
  assert.equal(final.tanks[0].weapon.shotOrdinal, 3);
  assert.equal(final.tanks[0].body.x, 102 * 256);
  return { boundaries, restoredTicks, final };
}

import assert from "node:assert/strict";

export async function verifyLaserLab(page, output) {
  await page.locator("#scenario").selectOption("laser");
  await page.locator("#players").selectOption("1");
  await page.locator("#assist").uncheck();
  await page.locator("#reset").click();
  await page.locator("#game").focus();
  const held = new Set(),
    shots = [],
    boundaries = [],
    restoredTicks = [];
  const controls = async (keys) => {
    for (const key of [...held])
      if (!keys.includes(key)) {
        await page.keyboard.up(key);
        held.delete(key);
      }
    for (const key of keys)
      if (!held.has(key)) {
        await page.keyboard.down(key);
        held.add(key);
      }
  };
  const read = () => page.evaluate(() => globalThis.combatLab.state());
  for (let tick = 1; tick <= 72; tick++) {
    await controls(
      tick >= 7 && tick <= 24
        ? ["ArrowUp", "KeyZ"]
        : tick >= 31 && tick <= 42
          ? ["ArrowRight", "KeyZ"]
          : [],
    );
    if (tick === 1 || tick === 49) await page.keyboard.press("KeyZ", { delay: 10 });
    await page.keyboard.press("Enter");
    const state = await read();
    assert.equal(state.tick, tick);
    if (state.events.some((event) => event.kind === "shot")) shots.push(tick);
    if (![1, 2, 7, 8, 13, 19, 24, 25, 31, 37, 42, 43, 49, 50].includes(tick)) continue;
    boundaries.push(state);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.screenshot({ path: `${output}/laser-${tick}.png` });
    const path = `${output}/laser-${tick}.json`,
      download = page.waitForEvent("download");
    await page.locator("#export").click();
    await (await download).saveAs(path);
    await controls([]);
    await page.locator("#reset").click();
    await page.locator("#import").setInputFiles(path);
    await page.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("imported replay matches"),
    );
    assert.deepEqual(await read(), state);
    restoredTicks.push(tick);
    await page.locator("#game").focus();
  }
  await controls([]);
  const final = await read();
  assert.deepEqual(shots, [1, 7, 13, 19, 31, 37, 49]);
  assert.equal(final.players[0].weapon.ammo, 113);
  assert.equal(final.players[0].weapon.shotOrdinal, 7);
  assert.equal(final.players[0].lives, 3);
  assert.equal(final.beams.length, 0);
  assert.equal(boundaries.find((state) => state.tick === 2).beams.length, 0);
  assert(
    boundaries.some((state) =>
      state.beams.some((beam) => beam.tick > beam.spawnTick && beam.heading === 1),
    ),
  );
  await page.locator("#replay").click();
  assert.match(await page.locator("#status").textContent(), /replay matches/);
  assert.deepEqual(await read(), final);
  return { shots, boundaries, restoredTicks, final };
}

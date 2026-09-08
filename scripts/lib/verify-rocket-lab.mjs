import assert from "node:assert/strict";

export async function verifyRocketLab(page, output) {
  await page.locator("#scenario").selectOption("rocket");
  await page.locator("#players").selectOption("1");
  await page.locator("#assist").uncheck();
  await page.locator("#reset").click();
  await page.locator("#game").focus();
  const read = () => page.evaluate(() => globalThis.combatLab.state());
  const boundaries = [],
    restoredTicks = [],
    shots = [],
    explosions = [];
  let holding = false,
    capturedBlast = false;
  const hold = async (next) => {
    if (next !== holding) await page.keyboard[next ? "down" : "up"]("KeyZ");
    holding = next;
  };
  for (let tick = 1; tick <= 160; tick++) {
    await hold(tick >= 31 && tick <= 55);
    if (tick === 1) await page.keyboard.press("Space", { delay: 10 });
    if (tick === 7) await page.keyboard.press("KeyZ", { delay: 10 });
    await page.keyboard.press("Enter");
    const state = await read();
    assert.equal(state.tick, tick);
    if (state.events.some((event) => event.kind === "shot")) shots.push(tick);
    const blast = state.events.some((event) => event.kind === "explosion");
    if (blast) explosions.push(tick);
    if (![7, 10, 31, 55, 121, 145].includes(tick) && !(blast && !capturedBlast)) continue;
    capturedBlast ||= blast;
    boundaries.push(state);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.screenshot({ path: `${output}/rocket-${tick}.png` });
    const path = `${output}/rocket-${tick}.json`,
      download = page.waitForEvent("download");
    await page.locator("#export").click();
    await (await download).saveAs(path);
    await hold(false);
    await page.locator("#reset").click();
    await page.locator("#import").setInputFiles(path);
    await page.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("imported replay matches"),
    );
    assert.deepEqual(await read(), state);
    restoredTicks.push(tick);
    await page.locator("#game").focus();
  }
  await hold(false);
  const final = await read();
  assert.deepEqual(shots, [7, 31, 55]);
  assert(explosions.length > 0);
  assert(
    boundaries.some((state) =>
      state.rockets.some(
        (rocket) => rocket.heading !== rocket.launchHeading && rocket.targetId !== null,
      ),
    ),
  );
  assert.equal(final.players[0].weapon.ammo, 17);
  assert.equal(final.players[0].weapon.shotOrdinal, 3);
  assert.equal(final.players[0].lives, 3);
  assert.equal(final.rockets.length, 0);
  await page.locator("#replay").click();
  assert.match(await page.locator("#status").textContent(), /replay matches/);
  assert.deepEqual(await read(), final);
  return { shots, explosions, boundaries, restoredTicks, final };
}

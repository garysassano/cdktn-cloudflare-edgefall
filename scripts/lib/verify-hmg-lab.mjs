import assert from "node:assert/strict";

export async function verifyHmgLab(page, output) {
  await page.locator("#scenario").selectOption("hmg");
  await page.locator("#players").selectOption("1");
  await page.locator("#assist").uncheck();
  await page.locator("#reset").click();
  await page.locator("#game").focus();
  const held = new Set(),
    boundaries = [],
    restoredTicks = [];
  const setKeys = async (next) => {
    for (const key of held) if (!next.has(key)) await page.keyboard.up(key);
    for (const key of next) if (!held.has(key)) await page.keyboard.down(key);
    held.clear();
    for (const key of next) held.add(key);
  };
  const read = () => page.evaluate(() => globalThis.combatLab.state());
  for (let tick = 1; tick <= 120; tick++) {
    const keys = new Set();
    if (tick <= 100) keys.add("KeyZ");
    if ((tick >= 6 && tick <= 25) || (tick >= 66 && tick <= 85) || tick >= 101) keys.add("ArrowUp");
    if ((tick >= 47 && tick <= 65) || (tick >= 91 && tick <= 100)) keys.add("ArrowDown");
    if (tick >= 86 && tick <= 90) keys.add("ArrowLeft");
    if (tick === 46) keys.add("Space");
    await setKeys(keys);
    await page.keyboard.press("Enter");
    const state = await read();
    assert.equal(state.tick, tick);
    if (![6, 7, 11, 48, 51, 97, 102].includes(tick)) continue;
    boundaries.push(state);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.screenshot({ path: `${output}/hmg-${tick}.png` });
    const path = `${output}/hmg-${tick}.json`,
      download = page.waitForEvent("download");
    await page.locator("#export").click();
    await (await download).saveAs(path);
    await setKeys(new Set());
    await page.locator("#reset").click();
    await page.locator("#import").setInputFiles(path);
    await page.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("imported replay matches"),
    );
    assert.deepEqual(await read(), state);
    restoredTicks.push(tick);
    await page.locator("#game").focus();
    await setKeys(keys);
  }
  await setKeys(new Set());
  const final = await read();
  assert.equal(final.players[0].weapon.ammo, 130);
  assert.equal(final.players[0].weapon.shotOrdinal, 20);
  assert.equal(final.players[0].lives, 3);
  assert.equal(final.players[0].firearmAim.pitch, 4);
  assert.equal(boundaries.find((state) => state.tick === 97).players[0].locomotion, "crouched");
  return { boundaries, restoredTicks, final };
}

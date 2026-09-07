import assert from "node:assert/strict";

export async function verifyOrdnanceLab(page, output) {
  await page.locator("#scenario").selectOption("ordnance");
  await page.locator("#players").selectOption("1");
  await page.locator("#assist").uncheck();
  await page.locator("#reset").click();
  await page.locator("#game").focus();
  await page.keyboard.press("KeyC", { delay: 10 });
  const read = () => page.evaluate(() => globalThis.combatLab.state());
  const boundaries = [],
    restoredTicks = [];
  for (let tick = 1; tick <= 100; tick++) {
    await page.keyboard.press("Enter");
    const state = await read();
    assert.equal(state.tick, tick);
    if (![5, 50, 82, 83, 95].includes(tick)) continue;
    boundaries.push(state);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.screenshot({ path: `${output}/ordnance-${tick}.png` });
    const path = `${output}/ordnance-${tick}.json`,
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
  const crushed = boundaries.find((state) => state.tick === 83),
    final = await read();
  assert.equal(crushed.events.length, 1);
  assert.equal(crushed.events[0].kind, "impact");
  assert.equal(crushed.events[0].impact.damage, 0);
  assert.equal(final.grenades.length, 0);
  assert.equal(final.players[0].grenadeStock, 9);
  assert.equal(final.players[0].lives, 3);
  assert(final.targets.every((target) => target.health === 1));
  return { boundaries, restoredTicks, final };
}

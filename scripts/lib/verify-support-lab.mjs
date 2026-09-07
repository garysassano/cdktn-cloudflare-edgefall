import assert from "node:assert/strict";

export async function verifySupportLab(page, output) {
  await page.locator("#scenario").selectOption("support");
  await page.locator("#players").selectOption("1");
  await page.locator("#assist").uncheck();
  await page.locator("#reset").click();
  await page.locator("#game").focus();
  const read = () => page.evaluate(() => globalThis.combatLab.state());
  const boundaries = [],
    restoredTicks = [];
  for (let tick = 1; tick <= 105; tick++) {
    if (tick <= 57 && (tick - 1) % 8 === 0) await page.keyboard.press("KeyZ", { delay: 10 });
    await page.keyboard.press("Enter");
    const state = await read();
    assert.equal(state.tick, tick);
    if (![35, 66, 67, 68, 80, 90, 91, 105].includes(tick)) continue;
    boundaries.push(state);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.screenshot({ path: `${output}/support-${tick}.png` });
    const path = `${output}/support-${tick}.json`,
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
  const final = await read();
  assert.equal(final.props[0].destroyedTick, 67);
  assert.equal(final.encounter.phase, "complete");
  assert(
    final.encounter.members.every(
      (member) =>
        member.reason === "out-of-bounds" && member.resolvedTick === 91 && member.killerId === null,
    ),
  );
  assert.equal(final.encounter.kills[0].count, 0);
  assert.equal(final.players[0].weapon.shotOrdinal, 8);
  return { boundaries, restoredTicks, final };
}

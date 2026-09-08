import assert from "node:assert/strict";

export async function verifyPickupLab(page, output) {
  await page.locator("#scenario").selectOption("pickups");
  await page.locator("#players").selectOption("4");
  await page.locator("#assist").uncheck();
  await page.locator("#reset").click();
  await page.locator("#game").focus();
  const held = new Set(),
    claims = [],
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
  for (let tick = 1; tick <= 120; tick++) {
    await controls([
      ...(tick <= 96 ? ["ArrowRight"] : []),
      ...(tick <= 110 ? ["ArrowUp", "KeyZ"] : []),
    ]);
    await page.keyboard.press("Enter");
    const state = await read();
    assert.equal(state.tick, tick);
    claims.push(...state.pickupClaims);
    if (![1, 9, 10, 12, 23, 24, 27, 46, 64, 82, 96, 110, 111, 120].includes(tick)) continue;
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const markers = await page.evaluate(() => globalThis.combatLab.supplyMarkers());
    assert.equal(markers.length, 6);
    for (const marker of markers) {
      const remaining =
        marker.sourceId === 506
          ? tick < 24
            ? 1
            : 0
          : 4 - claims.filter((claim) => claim.sourceId === marker.sourceId).length;
      assert.equal(marker.remaining, remaining);
      assert.equal(marker.visible, remaining > 0);
      assert.equal(marker.textVisible, remaining > 0);
      assert(marker.text.endsWith(`×${remaining}`));
    }
    boundaries.push({ state, markers });
    await page.screenshot({ path: `${output}/pickups-${tick}.png` });
    const path = `${output}/pickups-${tick}.json`,
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
  assert.equal(claims.length, 5);
  assert.equal(new Set(claims.map((claim) => claim.claimId)).size, 5);
  assert(claims.every((claim) => claim.playerId === 1));
  assert.equal(final.players[0].weapon.id, "laser");
  assert(final.players.every((player) => player.lives === 3));
  assert.equal(final.pickups.items.filter((item) => item.status === "available").length, 15);
  assert(boundaries.some(({ state }) => state.pickups.contacts.length > 0));
  await page.locator("#replay").click();
  assert.match(await page.locator("#status").textContent(), /replay matches/);
  assert.deepEqual(await read(), final);
  return {
    claims,
    boundaries,
    restoredTicks,
    final,
    scope:
      "One real keyboard crosses five shared four-item piles; idle allies leave remaining items available. Actual count markers and private contact latches survive fourteen recording imports. Separate network runs control all four clients.",
  };
}

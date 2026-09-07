import assert from "node:assert/strict";

/** Real local inspector keyboard input, then export/import at a broken-shield boundary. */
export async function verifyShieldLab(page, output) {
  await page.locator("#scenario").selectOption("guard");
  await page.locator("#players").selectOption("1");
  await page.locator("#assist").uncheck();
  await page.locator("#reset").click();
  const surface = page.locator("#game"),
    read = () => page.evaluate(() => globalThis.combatLab.state());
  await surface.focus();
  const boundaries = [];
  for (let tick = 1; tick <= 131; tick++) {
    if (tick === 1) {
      await page.keyboard.down("ArrowDown");
      await page.keyboard.press("KeyC");
    } else if (tick === 6) {
      await page.keyboard.up("ArrowDown");
      await page.keyboard.down("ArrowRight");
    } else if (tick === 24) await page.keyboard.press("Space");
    else if (tick === 57) {
      await page.keyboard.up("ArrowRight");
      await page.keyboard.down("ArrowDown");
    }
    await page.keyboard.press("Enter");
    if ([34, 66, 95, 130, 131].includes(tick)) {
      const state = await read();
      boundaries.push({
        tick,
        guard: state.targets[0].guard,
        health: state.targets[0].health,
        player: state.players[0],
      });
      if (tick <= 95) {
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        await page.screenshot({ path: `${output}/shield-${tick}.png` });
      }
      if (tick === 95) {
        assert.equal(state.targets[0].guard.phase, "stunned");
        assert.equal(state.targets[0].guard.integrity, 0);
        assert.equal(state.targets[0].health, 1);
        assert.equal(state.players[0].lives, 3);
        const path = `${output}/shield-broken.json`,
          downloaded = page.waitForEvent("download");
        await page.locator("#export").click();
        await (await downloaded).saveAs(path);
        await page.locator("#reset").click();
        await page.locator("#import").setInputFiles(path);
        await page.waitForFunction(() =>
          document.querySelector("#status").textContent.includes("imported replay matches"),
        );
        assert.deepEqual(await read(), state);
        await surface.focus();
        await page.keyboard.down("ArrowDown");
      }
    }
  }
  await page.keyboard.up("ArrowDown");
  assert.equal(boundaries.find((boundary) => boundary.tick === 130).guard.phase, "stunned");
  assert.notEqual(boundaries.find((boundary) => boundary.tick === 131).guard.phase, "stunned");
  assert.equal((await read()).targets[0].guard.integrity, 0);
  return { boundaries, restoredTick: 95 };
}

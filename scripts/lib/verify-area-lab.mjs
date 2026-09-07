import assert from "node:assert/strict";

/** Actual keyboard input with paused presentation boundaries and recording replay. */
export async function verifyAreaLab(page, output) {
  const scenarios = [];
  for (const mode of ["shotgun", "flame"]) {
    await page.locator("#scenario").selectOption(mode);
    await page.locator("#players").selectOption("1");
    await page.locator("#assist").uncheck();
    await page.locator("#reset").click();
    const read = () => page.evaluate(() => globalThis.combatLab.state());
    await page.locator("#game").focus();
    await page.keyboard.down("ArrowDown");
    await page.keyboard.down("KeyZ");
    const boundaries = [],
      effects = [];
    for (let tick = 1; tick <= 31; tick++) {
      await page.keyboard.press("Enter");
      if (tick === 1) await page.keyboard.up("KeyZ");
      const state = await read();
      effects.push(
        ...state.events
          .filter((event) => ["shot", "impact", "shield-break", "killed"].includes(event.kind))
          .map((event) => ({ tick, ...event })),
      );
      if ((mode === "shotgun" ? [1, 4, 6, 7] : [6, 7, 13, 19, 30, 31]).includes(tick)) {
        boundaries.push({
          tick,
          areas: state.areas,
          player: state.players[0],
          targets: state.targets,
        });
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        if ((mode === "shotgun" && tick === 6) || (mode === "flame" && tick === 13)) {
          await page.screenshot({ path: `${output}/${mode}-volumes.png` });
          const download = page.waitForEvent("download"),
            path = `${output}/${mode}-active.json`;
          await page.locator("#export").click();
          await (await download).saveAs(path);
          await page.locator("#reset").click();
          await page.locator("#import").setInputFiles(path);
          await page.waitForFunction(() =>
            document.querySelector("#status").textContent.includes("imported replay matches"),
          );
          assert.deepEqual(await read(), state);
          await page.locator("#game").focus();
          await page.keyboard.down("ArrowDown");
        }
      }
    }
    await page.keyboard.up("ArrowDown");
    const final = await read();
    assert.equal(final.players[0].weapon.ammo, mode === "shotgun" ? 23 : 29);
    assert.equal(final.players[0].weapon.shotOrdinal, 1);
    assert.equal(final.players[0].lives, 3);
    assert.deepEqual(final.areas, []);
    assert.deepEqual(
      effects
        .filter((event) => event.kind === "shot" && event.ownerId === 1)
        .map((event) => event.tick),
      mode === "shotgun" ? [1] : [1, 7, 13],
    );
    scenarios.push({ mode, boundaries, effects, final, restoredTick: mode === "shotgun" ? 6 : 13 });
  }
  return { scenarios };
}

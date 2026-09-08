import assert from "node:assert/strict";

export async function verifyMissionAudio(page) {
  await page.locator("#players").selectOption("1");
  await page.locator("#reset").click();
  await page.locator("#sound").check();
  await page.waitForFunction(() => globalThis.breakwater.audio().ready);
  await page.locator("#run").click();
  await page.waitForTimeout(160);
  let audio = await page.evaluate(() => globalThis.breakwater.audio());
  assert(audio.music.playing && audio.music.voices === 1);
  assert(audio.decodedBytes + audio.music.decodedBytes <= 32 * 1024 * 1024);
  await page.locator("#run").click();
  const paused = await page.evaluate(() => globalThis.breakwater.audio().music);
  await page.waitForTimeout(160);
  assert.equal(
    (await page.evaluate(() => globalThis.breakwater.audio().music)).seconds,
    paused.seconds,
  );
  assert.equal(paused.voices, 0);
  await page.locator("#run").click();
  await page.waitForTimeout(160);
  assert((await page.evaluate(() => globalThis.breakwater.audio().music)).seconds > paused.seconds);
  const toggle = (id) => page.evaluate((id) => document.getElementById(id).click(), id);
  await toggle("music");
  audio = await page.evaluate(() => globalThis.breakwater.audio());
  assert.equal(audio.music.voices, 0);
  assert.equal(audio.music.playing, true);
  const muted = audio.music.seconds;
  await page.waitForTimeout(160);
  await toggle("music");
  await page.waitForFunction(() => globalThis.breakwater.audio().music.voices === 1);
  assert((await page.evaluate(() => globalThis.breakwater.audio().music)).seconds > muted + 0.1);
  await toggle("sound");
  audio = await page.evaluate(() => globalThis.breakwater.audio());
  assert.equal(audio.activeVoices + audio.music.voices, 0);
  await toggle("sound");
  await page.waitForFunction(() => globalThis.breakwater.audio().music.voices === 1);
  await page.locator("#run").click();
  await page.evaluate(() => {
    for (const [id, value] of [
      ["effects-volume", "0.2"],
      ["music-volume", "0.55"],
    ]) {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event("input"));
    }
  });
  await page.reload();
  await page.waitForFunction(() => globalThis.breakwater?.frames().hero.length > 0);
  assert.equal(await page.locator("#effects-volume").inputValue(), "0.2");
  assert.equal(await page.locator("#music-volume").inputValue(), "0.55");
  assert.equal(await page.locator("#sound").isChecked(), true);
  assert.equal(await page.locator("#music").isChecked(), true);
  assert.equal((await page.evaluate(() => globalThis.breakwater.audio())).state, "locked");
  await page.locator("#run").click();
  await page.waitForFunction(() => globalThis.breakwater.audio().ready);
  await page.locator("#run").click();
  const loops = await page.evaluate(async () => {
    const metadata = await (await fetch("/assets/audio/breakwater-music.json")).json();
    const results = [];
    for (const track of metadata.tracks) {
      const context = new OfflineAudioContext(2, track.frames * 2, 48000),
        buffer = await context.decodeAudioData(await (await fetch(`/${track.file}`)).arrayBuffer()),
        source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.loopStart = track.loopStart;
      source.loopEnd = track.loopEnd;
      source.connect(context.destination);
      source.start();
      const rendered = await context.startRendering();
      let delta = 0,
        peak = 0,
        energy = 0;
      for (let channel = 0; channel < 2; channel++) {
        const pcm = rendered.getChannelData(channel);
        delta = Math.max(delta, Math.abs(pcm[track.frames] - pcm[track.frames - 1]));
        for (const value of pcm) {
          peak = Math.max(peak, Math.abs(value));
          energy += value * value;
        }
      }
      results.push({
        id: track.id,
        decodedFrames: buffer.length,
        renderedFrames: rendered.length,
        seamDelta: delta,
        peak,
        rms: Math.sqrt(energy / rendered.length / 2),
      });
    }
    return results;
  });
  for (const loop of loops) {
    assert.equal(loop.decodedFrames, 1_280_000);
    assert.equal(loop.renderedFrames, 2_560_000);
    assert(loop.seamDelta < 0.025 && loop.peak < 0.7 && loop.rms > 0.01);
  }
  await page.evaluate(() => {
    for (const [id, value] of [
      ["effects-volume", "0.4"],
      ["music-volume", "0.35"],
    ]) {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event("input"));
    }
  });
  return {
    checks: [
      "Music pause/resume preserves position; music mute preserves its local clock; audio-off stops every voice.",
      "Music and effects volumes and mute preferences survive reload; playback remains gesture-locked.",
      "Both Vorbis arrangements decode and loop twice through Chromium OfflineAudioContext with bounded seams and headroom.",
    ],
    loops,
  };
}

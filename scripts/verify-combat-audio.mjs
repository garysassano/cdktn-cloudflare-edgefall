import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { Held } from "../src/game/input/types.ts";
import { createCombatLab, stepCombatLab } from "../src/game/labs/combat.ts";
import { combatAudioCues, combatAudioLoops } from "../src/shared/animation/combat-audio.ts";
import { recordTankCombat, tankDamageInput } from "../test/fixtures/tank-proof.ts";

const output = "dist/combat-audio-evidence",
  hash = (b) => createHash("sha256").update(b).digest("hex");
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `
import { CastAudio } from "./src/client/cast-audio.ts";
import { CombatMixer } from "./src/client/combat-mixer.ts";
import { SceneAudioOutput } from "./src/client/scene-audio-output.ts";
import { MissionMusic } from "./src/client/mission-music.ts";
import { COMBAT_AUDIO, COMBAT_LOOPS, SFX_PROFILES } from "./src/shared/animation/sfx-profile.ts";
let audio = new CastAudio();
globalThis.audioProof = {
  audio: () => audio,
  recreate: () => { audio.dispose(); audio = new CastAudio(); },
  async stress(loops) {
    const context = new AudioContext({sampleRate:48000}); await context.resume();
    const scene=new SceneAudioOutput(context), output=context.createGain(); output.gain.value=1; output.connect(scene.input);
    const music=new MissionMusic(context,scene.input); music.setVolume(1); await music.setEnabled(true);
    const buffers=new Map();
    for(const file of new Set(Object.values(SFX_PROFILES).flatMap(p=>p.files)))
      buffers.set(file,await context.decodeAudioData(await (await fetch('/assets/audio/'+file)).arrayBuffer()));
    const mixer=new CombatMixer(context,output,buffers), capture=context.createMediaStreamDestination(); scene.connect(capture);
    const recorder=new MediaRecorder(capture.stream,{mimeType:'audio/webm;codecs=opus'}),chunks=[];
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};recorder.start();music.play();
    mixer.syncLoops(loops);
    const initial=mixer.inspect();
    const shots=Array.from({length:36},(_,i)=>({id:'stress:'+i,kind:i<12?'hmg':i<20?'sidearm':'impact-metal',tick:1,x:192,emitter:'actor:'+i}));
    mixer.play(shots,1);mixer.play([{id:'critical',kind:'boss-warning',tick:1,x:192,emitter:'boss'}],1);
    const admitted=mixer.inspect();
    let maxAudible=0;
    for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,5));maxAudible=Math.max(maxAudible,mixer.inspect().audibleVoices);}
    await new Promise(r=>setTimeout(r,550));mixer.syncLoops(loops);
    const restored=mixer.inspect();mixer.hush();
    await new Promise(r=>setTimeout(r,60));
    const bytes=await new Promise(resolve=>{recorder.onstop=async()=>resolve([...new Uint8Array(await new Blob(chunks).arrayBuffer())]);recorder.stop();});
    for(const track of capture.stream.getTracks())track.stop();music.dispose();scene.dispose();await context.close();
    return {sfxVolume:1,musicVolume:1,initial,admitted,restored,maxAudible,bytes,closed:context.state};
  },
  async comparison() {
    audio.reset();audio.startCapture();const rows=[];
    let tick=1;
    for(const kind of ['sidearm','hmg','rifle','shotgun','tank','boss-fire','boss-warning','knife','throw','grenade-bounce','explosion','shield','shield-break','wood-break','board','exit','eject','tank-hit','tank-land','tank-destroyed','boss-destroyed','pickup','entry']) {
      rows.push({kind,time:performance.now(),audioTime:audio.inspect().contextSeconds});
      for(let i=0;i<(kind==='hmg'?6:1);i++) {
        const state={tick,players:[],tanks:[],areas:[]};
        audio.consume(state,[{id:'comparison:'+tick,kind,tick,x:192,emitter:'comparison'}]);tick+=kind==='hmg'?6:66;
        if(kind==='hmg')await new Promise(r=>setTimeout(r,100));
      }
      await new Promise(r=>setTimeout(r,1100));
    }
    const inspect=audio.inspect(),blob=await audio.stopCapture();audio.hush();
    return {rows,inspect,bytes:[...new Uint8Array(await blob.arrayBuffer())]};
  }
};
document.querySelector('button').onclick=()=>audio.setEnabled(true);
`,
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
});
const server = createServer(async (request, response) => {
  const name = new URL(request.url, "http://localhost").pathname;
  try {
    if (name === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end('<button>Unlock audio</button><script src="/proof.js"></script>');
      return;
    }
    if (name === "/proof.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundle.outputFiles[0].contents);
      return;
    }
    const path = resolve("public", `.${name}`);
    if (!path.startsWith(`${resolve("public/assets")}/`)) throw new Error("Outside assets");
    response.setHeader("Content-Type", name.endsWith(".ogg") ? "audio/ogg" : "application/json");
    response.end(await readFile(path));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const report = {
  scope:
    "Recorded benchmark cues, real WebAudio lifecycle, decoded loops and explicit maximum mixer load. Physical output, network integration and human listening approval remain open.",
  browserAudioOutput: "Chromium --disable-audio-output",
  bundleSha256: hash(bundle.outputFiles[0].contents),
  checks: [],
  files: [],
};
const browser = await chromium.launch({
  executablePath: process.env.EDGEFALL_CHROMIUM_PATH,
  args: ["--disable-audio-output"],
});
try {
  const page = await browser.newPage(),
    errors = [],
    requests = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await page.evaluate(() => audioProof.audio().inspect().state), "locked");
  await page.locator("button").click();
  await page.waitForFunction(() => audioProof.audio().inspect().ready);
  report.preload = await page.evaluate(() => audioProof.audio().inspect());
  assert.equal(report.preload.decodedSamples, 52);
  assert(report.preload.decodedBytes < 8 * 1024 * 1024);
  report.decoded = await page.evaluate(async () => {
    const metadata = await (await fetch("/assets/audio/sfx/breakwater-sfx.json")).json(),
      results = [];
    for (const clip of metadata.clips) {
      const context = new OfflineAudioContext(1, clip.frames * (clip.loop ? 3 : 1), 48000),
        buffer = await context.decodeAudioData(await (await fetch(`/${clip.file}`)).arrayBuffer()),
        source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = clip.loop;
      source.loopEnd = clip.loopEnd;
      source.connect(context.destination);
      source.start();
      const rendered = await context.startRendering(),
        pcm = rendered.getChannelData(0);
      let peak = 0,
        energy = 0,
        seam = 0;
      for (const value of pcm) {
        peak = Math.max(peak, Math.abs(value));
        energy += value * value;
      }
      if (clip.loop)
        for (const i of [clip.frames, clip.frames * 2])
          seam = Math.max(seam, Math.abs(pcm[i] - pcm[i - 1]));
      results.push({
        id: clip.id,
        expectedFrames: clip.frames,
        decodedFrames: buffer.length,
        renderedFrames: rendered.length,
        loop: clip.loop,
        peak,
        rms: Math.sqrt(energy / pcm.length),
        seam,
      });
    }
    return results;
  });
  for (const clip of report.decoded) {
    assert.equal(clip.decodedFrames, clip.expectedFrames, `${clip.id}: browser length`);
    assert(clip.peak < 0.9 && clip.rms > 0.006, `${clip.id}: browser signal`);
    if (clip.loop) assert(clip.seam < 0.025, `${clip.id}: browser loop seam`);
  }
  report.checks.push(
    "Every Vorbis cue decodes at its declared length; both loops repeat three times through OfflineAudioContext.",
  );
  const tankRun = recordTankCombat(196, tankDamageInput),
    seated = tankRun.states[15].combat,
    ejected = tankRun.states[183].combat;
  let flame = createCombatLab("flame", 4);
  flame = stepCombatLab(
    flame,
    flame.players.map(() => ({
      held: Held.Fire,
      firePressed: true,
      jumpPressed: false,
      grenadePressed: false,
      specialPressed: false,
      interactPressed: false,
    })),
  );
  report.lifecycle = [];
  const inspect = () => page.evaluate(() => audioProof.audio().inspect());
  const resume = async (state) => {
    await page.evaluate((state) => audioProof.audio().resume(state), state);
    await page.waitForTimeout(40);
    return inspect();
  };
  const noTriggerRequests = requests.length;
  let current = await resume(seated);
  assert.equal(current.loops.length, 4);
  const startTimes = current.loops.map((v) => v.started);
  current = await resume(seated);
  assert.deepEqual(
    current.loops.map((v) => v.started),
    startTimes,
    "Reconciliation restarted engines",
  );
  report.lifecycle.push({ case: "four engines and idempotent resume", audio: current });
  await page.evaluate(() => audioProof.audio().hush());
  assert.equal((await inspect()).activeVoices, 0);
  current = await resume(flame);
  assert.equal(current.loops.length, 4);
  report.lifecycle.push({ case: "four accepted flame emitters", audio: current });
  await page.evaluate(() => audioProof.audio().setEnabled(false));
  assert.equal((await inspect()).activeVoices, 0);
  await page.evaluate(() => audioProof.audio().setEnabled(true));
  current = await resume(seated);
  assert.equal(current.loops.length, 4);
  current = await resume(ejected);
  assert.equal(current.loops.length, 3);
  report.lifecycle.push({ case: "accepted armor loss stops the fourth engine", audio: current });
  await page.evaluate(() => audioProof.audio().finish());
  await page.waitForTimeout(40);
  assert.equal((await inspect()).activeVoices, 0);
  await resume(flame);
  await page.evaluate(() => audioProof.audio().reset());
  assert.equal((await inspect()).activeVoices, 0);
  assert.equal(requests.length, noTriggerRequests, "Trigger or lifecycle requested a sound file");
  const cues = combatAudioCues(tankRun.states[182].combat, ejected);
  await page.evaluate(
    ({ state, cues }) => {
      audioProof.audio().consume(state, cues);
      audioProof.audio().consume(state, cues);
    },
    { state: ejected, cues },
  );
  current = await inspect();
  assert.equal(current.cues.filter((c) => c.kind === "eject").length, 1);
  report.lifecycle.push({ case: "duplicate accepted ejection plays once", audio: current });
  report.captureDisposal = await page.evaluate(async () => {
    audioProof.audio().startCapture();
    const stopped = audioProof
      .audio()
      .stopCapture()
      .then(
        () => "resolved",
        (error) => String(error),
      );
    audioProof.audio().dispose();
    return stopped;
  });
  assert(report.captureDisposal.includes("disposed during capture"));
  assert.equal((await inspect()).activeVoices, 0);
  assert.equal((await inspect()).decodedBytes, 0);
  await page.evaluate(() => audioProof.recreate());
  await page.locator("button").click();
  await page.waitForFunction(() => audioProof.audio().inspect().ready);
  report.checks.push(
    "Engine sources survive repeated reconciliation; pause, audio-off, accepted ejection, finish, replay reset and disposal clear loops. No trigger fetches; duplicate ejection is consumed once.",
  );
  const stress = await page.evaluate(
    (loops) => audioProof.stress(loops),
    [...combatAudioLoops(seated), ...combatAudioLoops(flame)],
  );
  const stressBytes = Buffer.from(stress.bytes);
  delete stress.bytes;
  await writeFile(`${output}/maximum-mix.webm`, stressBytes);
  report.stress = stress;
  assert.equal(stress.initial.loops.length, 8);
  assert(stress.admitted.cues.some((c) => c.kind === "boss-warning"));
  assert.equal(stress.admitted.criticalDropped, 0);
  assert(stress.admitted.maxActiveVoices <= 32 && stress.maxAudible <= 32);
  assert(stress.admitted.maxSourceNodes <= 64);
  assert.equal(stress.restored.loops.length, 8);
  assert.equal(stress.closed, "closed");
  report.checks.push(
    "Eight persistent loops plus 36 transients exercise priority pressure. The warning is admitted, audible voices stay within 32 and virtual engines return from current state.",
  );
  console.log("Decode, lifecycle and priority checks passed; capturing weapon comparison.");
  const comparison = await page.evaluate(() => audioProof.comparison());
  const comparisonBytes = Buffer.from(comparison.bytes);
  delete comparison.bytes;
  await writeFile(`${output}/weapon-comparison.webm`, comparisonBytes);
  report.comparison = comparison;
  assert.equal(comparison.inspect.coalesced, 0);
  assert.equal(comparison.inspect.dropped, 0);
  assert.equal(comparison.inspect.cues.length, comparison.rows.length + 5);
  for (const name of ["maximum-mix", "weapon-comparison"]) {
    const bytes = await readFile(`${output}/${name}.webm`),
      pcm = execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          `${output}/${name}.webm`,
          "-ac",
          "2",
          "-ar",
          "48000",
          "-f",
          "f32le",
          "pipe:1",
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      );
    const channels = [
      { peak: 0, energy: 0 },
      { peak: 0, energy: 0 },
    ];
    for (let i = 0; i < pcm.length; i += 4) {
      const v = pcm.readFloatLE(i),
        c = channels[(i / 4) % 2];
      c.peak = Math.max(c.peak, Math.abs(v));
      c.energy += v * v;
    }
    report.files.push({
      file: `${name}.webm`,
      bytes: bytes.length,
      sha256: hash(bytes),
      seconds: pcm.length / 8 / 48000,
      channels: channels.map((c) => ({
        peak: c.peak,
        rms: Math.sqrt(c.energy / (pcm.length / 8)),
      })),
    });
  }
  for (const file of report.files)
    for (const channel of file.channels)
      assert(
        channel.peak < 0.99 && channel.rms > 0.0001,
        `${file.file}: clipped or silent stereo channel`,
      );
  report.checks.push(
    "Full-volume effects and music pass stereo headroom through the shared output guard; the comparison retains every intended release.",
  );
  assert.deepEqual(errors, []);
  report.status = "pass";
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: report.status,
      decode: report.decoded.length,
      checks: report.checks.length,
      files: report.files,
    }),
  );
} catch (error) {
  report.status = "fail";
  report.error = String(error);
  await writeFile(`${output}/failure.json`, `${JSON.stringify(report, null, 2)}\n`);
  throw error;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

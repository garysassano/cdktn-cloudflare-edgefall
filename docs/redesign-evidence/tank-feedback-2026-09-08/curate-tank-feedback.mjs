import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
const {build}=createRequire(resolve('package.json'))('esbuild');
const destination='docs/redesign-evidence/tank-feedback-2026-09-08';
await assert.rejects(access(destination),'Preserve existing evidence packages');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const artifacts=new Map(),runtimeInputs={};
const json=async path=>JSON.parse(await readFile(path));
const storage=await json('dist/combat-storage-proof/report.json');
const network=await json('dist/network-combat-tank-damage-evidence/report.json');
const native=await json('dist/tank-feedback-evidence/report.json');
const audio=await json('dist/combat-audio-evidence/report.json');
for(const report of [storage,network,native,audio])assert.equal(report.status,'pass');
const damage=storage.tank.scenarios.find(s=>s.mode==='damage');
assert.equal(damage.boundaries.length,14);
assert.equal(native.captures.length,17);
assert.equal(native.movies.length,2);
assert(network.sharedSnapshots>=10);
const checkLog=await readFile('/tmp/edgefall-tank-feedback-check.log','utf8');
assert.match(checkLog,/Tests\s+885 passed/);
assert.match(checkLog,/Test Files\s+81 passed/);
async function bundle(name,options,expected,sourceExpected) {
 const result=await build({...options,write:false,metafile:true}),bytes=result.outputFiles[0].contents;
 assert.equal(hash(bytes),expected,`${name} rebuilt bytes differ`);
 const inputs=Object.keys(result.metafile.inputs).sort(),composite=createHash('sha256');
 for(const path of inputs)composite.update(path).update('\0').update(path==='<stdin>'?options.stdin.contents:await readFile(path)).update('\0');
 const sourceSha256=composite.digest('hex');
 if(sourceExpected)assert.equal(sourceSha256,sourceExpected,`${name} source changed`);
 runtimeInputs[name]={sourceSha256,bundleSha256:expected,paths:inputs};
 artifacts.set(`${name}.js.gz`,gzipSync(bytes));
}
await bundle('storage-worker',{entryPoints:['test/fixtures/combat-storage-worker.ts'],bundle:true,external:['cloudflare:workers'],platform:'neutral',format:'esm'},storage.workerBundleSha256,storage.sourceSha256);
await bundle('network-worker',{entryPoints:['src/worker/diagnostics/room-probe.ts'],bundle:true,external:['cloudflare:workers'],platform:'neutral',format:'esm'},network.workerBundleSha256);
for(const [name,expected] of [['network-lab',network.bundleSha256],['combat-lab',native.bundleSha256]])
 await bundle(name,{entryPoints:[resolve(`src/client/${name}.ts`)],bundle:true,format:'iife',outfile:resolve(`dist/client/${name}.js`),platform:'browser',target:'es2022'},expected);
const audioHarness=await readFile('scripts/verify-combat-audio.mjs','utf8'),audioStdin=audioHarness.match(/contents: `([\s\S]*?)`,\n  },/);
assert(audioStdin,'Missing audio browser source');
await bundle('audio-browser',{stdin:{resolveDir:process.cwd(),contents:audioStdin[1]},bundle:true,format:'iife',platform:'browser',target:'es2022'},audio.bundleSha256);
artifacts.set('storage.json.gz',gzipSync(await readFile('dist/combat-storage-proof/report.json')));
for(const [prefix,directory] of [
 ['network','dist/network-combat-tank-damage-evidence'],
 ['native','dist/tank-feedback-evidence'],
 ['audio','dist/combat-audio-evidence'],
 ['initial-network','/tmp/edgefall-tank-feedback-network-initial-evidence'],
])for(const name of await readdir(directory)) {
 if(prefix==='audio'&&!['report.json','maximum-mix.webm','weapon-comparison.webm'].includes(name))continue;
 if(!/\.(?:json|png|webm)$/.test(name))continue;
 const bytes=await readFile(`${directory}/${name}`),binary=/\.(png|webm)$/.test(name);
 artifacts.set(`${prefix}-${name}${binary?'':'.gz'}`,binary?bytes:gzipSync(bytes));
}
for(const name of ['focused','check','network','network-initial','browser','browser-initial','audio','storage'])
 artifacts.set(`${name}.log.gz`,gzipSync(await readFile(`/tmp/edgefall-tank-feedback-${name}.log`)));
const configs=await Promise.all(['wrangler.jsonc','.wrangler.deploy.json'].map(async path=>{
 const c=path.endsWith('.jsonc')?JSON.parse((await readFile(path,'utf8')).replace(/^\s*\/\/.*$/gmu,'')):await json(path),result={path,upload_source_maps:c.upload_source_maps,observability:c.observability};
 assert.equal(result.upload_source_maps,true);assert.equal(result.observability.enabled,true);
 assert.deepEqual(result.observability.traces,{enabled:true,head_sampling_rate:1});
 assert.deepEqual(result.observability.logs,{enabled:true,invocation_logs:true,head_sampling_rate:1});
 return result;
}));
const summary={
 checks:{tests:885,files:81},
 armor:{impactTicks:[37,43,49,51,57,63,110,116,122,124,130,136,183],debitTicks:[37,110,183],snapshotAndCheckpointBoundaries:[36,37,43,67,109,110,116,120,140,182,183,195]},
 native:{captures:native.captures.length,pixels:native.captures.reduce((s,c)=>s+c.pixels,0),movies:native.movies.map(m=>({speed:m.speed,tick:m.tick,cues:m.audio.cues.length,armorCues:m.audio.cues.filter(c=>c.kind==='tank-hit').map(c=>c.tick),maxVoices:m.audio.maxActiveVoices,criticalDropped:m.audio.criticalDropped}))},
 sqlite:{boundaries:damage.boundaries.length,ticks:damage.boundaries.map(b=>b.saved.tick),maxArchiveRows:Math.max(...damage.boundaries.map(b=>b.saved.archiveRows)),feedback:damage.boundaries.map(b=>({tick:b.saved.tick,tanks:b.feedback}))},
 network:{tick:network.tank.final.tick,clientTicks:network.tank.clients.map(c=>c.snapshotTick),sharedSnapshots:network.sharedSnapshots,sharedEvents:network.tank.commonEvents.length,duplicates:network.tank.clients.reduce((s,c)=>s+c.events.duplicates,0),observedArmorBoundaries:network.tank.boundaries.map(b=>({tick:b.state.tick,feedback:b.feedback})),lives:network.tank.final.combat.world.players.map(p=>p.lives),armor:network.tank.final.combat.world.tanks.map(t=>t.armor),worldFailure:network.room.worldFailure,clockFault:network.room.clock.fault},
 audio:{decodedSamples:audio.decoded.length,damage:audio.lifecycle.filter(l=>/thirteen impacts|critical checkpoint/.test(l.case)).map(l=>({case:l.case,cues:l.audio.cues.map(c=>({kind:c.kind,tick:c.tick})),loops:l.audio.loops.length})),files:audio.files},
 observability:{configs,liveIngestionVerified:false,deployedTimingVerified:false},
};
const controls=[
 {name:'initial-native-pixel-fixture',reason:'The first pixel comparison disabled the native operative, leaving engineering player colliders over the hull at tick zero. The proof now uses the actual operative layers and includes them in the independent pixel composition; the failed log is retained.'},
 {name:'Phaser-4-tint-mode',reason:'Type checking caught the removed Phaser 3 setTintFill method. The adapter uses installed Phaser 4 setTint/setTintMode and resets mode for every reused image. Browser pixels verify both the brief fill and later multiply state.'},
 {name:'initial-network-expectation',reason:'The initial proof expected every other tank to retain full armor after P4 destruction. Recorded snapshots show rifle fire reaching P3 after the fourth hull becomes a nonblocking wreck. The passing proof checks that real impact and P3 armor 2 while retaining all peer and clock guards.'},
 {name:'initial-network-failure-capture',reason:'The retained failed run also records a P2 mapping fresh-baseline fault after tick 240 and later seat release. The successful independent run agrees across all four clients at tick 228. This checkpoint does not resolve the historical host-clock or broader impairment findings.'},
 {name:'tank-component-scope',reason:'The tank specification retains three armor pips and working hardpoints until destruction. Separate breakable gun arms belong to the walker. This checkpoint adds feedback, not invented tank weapon loss or final authored damage media.'},
];
for(const [name,value] of Object.entries({summary,controls,runtimeInputs}))artifacts.set(`${name}.json`,Buffer.from(JSON.stringify(value,null,2)+'\n'));
artifacts.set('curate-tank-feedback.mjs',await readFile(import.meta.filename));
const denied=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,/\bgithub_pat_[A-Za-z0-9_]{20,}\b/,/\bBearer [A-Za-z0-9_\-.]{20,}/i,/\b(?:access_token|refresh_token|api_token)\s*[=:]\s*["'][A-Za-z0-9_\-.]{20,}/i];
const deniedKeys=/^(?:authorization|cookie|cookies|set-cookie|token|apiToken|api_token|accessToken|access_token|refresh_token|profileSecret|profileCookieSecret|resumeClaim|admissionClaim)$/i;
function scan(value,path='root') {
 if(!value||typeof value!=='object')return;
 for(const [key,child] of Object.entries(value)){assert(!deniedKeys.test(key),`Credential-like report field at ${path}.${key}`);scan(child,`${path}.${key}`);}
}
for(const [path,bytes] of artifacts)if(!/\.(png|webm)$/.test(path)) {
 const plain=(path.endsWith('.gz')?gunzipSync(bytes):bytes).toString();assert(!denied.some(pattern=>pattern.test(plain)),`Credential pattern in ${path}`);
 if(/\.json(?:\.gz)?$/.test(path))scan(JSON.parse(plain),path);
}
const allInputs=Object.values(runtimeInputs).flatMap(item=>item.paths);
const sourcePaths=[...new Set([...allInputs.filter(path=>!path.startsWith('node_modules/')&&path!=='<stdin>'),...execFileSync('rg',['--files','src','test','scripts','e2e','package.json','pnpm-lock.yaml','mise.toml','vitest.config.ts','tsconfig.json','wrangler.jsonc','worker-configuration.d.ts','public/assets/manifest.json'],{encoding:'utf8'}).trim().split('\n')])].sort();
const fingerprint=async path=>{const bytes=await readFile(path);return {path,bytes:bytes.length,sha256:hash(bytes)};};
const sources=await Promise.all(sourcePaths.map(fingerprint)),dependencies=await Promise.all([...new Set(allInputs.filter(path=>path.startsWith('node_modules/')))].sort().map(fingerprint));
const manifest={format:1,baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'Accepted tank armor feedback and critical indicators using existing media. Portable snapshot/checkpoint reconstruction, actual SQLite restarts, four keyboard clients, native pixel comparisons and WebAudio. W08 final media/lifecycle/impairment acceptance, authored missions, production v3 and deployed cadence/trace ingestion remain open.',runtimeInputs:Object.fromEntries(Object.entries(runtimeInputs).map(([name,{paths,...identity}])=>[name,identity])),sources,dependencies,artifacts:[]};
await mkdir(destination);
for(const [path,bytes] of artifacts){await writeFile(`${destination}/${path}`,bytes);manifest.artifacts.push({path,bytes:bytes.length,sha256:hash(bytes)});}
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(`${destination}/artifacts.json`,bytes);
console.log(JSON.stringify({destination,sources:sources.length,dependencies:dependencies.length,artifacts:manifest.artifacts.length,bytes:manifest.artifacts.reduce((s,a)=>s+a.bytes,0),manifestSha256:hash(bytes),summary}));

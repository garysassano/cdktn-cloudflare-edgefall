import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
const {build}=createRequire(resolve('package.json'))('esbuild');
const destination='docs/redesign-evidence/material-room-2026-09-08';
await assert.rejects(access(destination),'Preserve existing evidence packages');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const paths={contracts:'dist/contract-runtime-proof/report.json',storage:'dist/combat-storage-proof/report.json',lab:'dist/combat-lab-evidence/report.json',materials:'dist/material-lab-evidence/report.json',rooms:'dist/material-room-runtime-proof/report.json',network:'dist/network-material-room-evidence/report.json'};
const reports={},artifacts=new Map(),runtimeInputs={};
for(const [name,path] of Object.entries(paths)) {
  const bytes=await readFile(path);reports[name]=JSON.parse(bytes);assert.equal(reports[name].status,'pass',name);
  artifacts.set(`${name}.json.gz`,gzipSync(bytes));
}
assert.equal(reports.rooms.groups.reduce((sum,g)=>sum+g.cases.length,0),128);
assert.equal(reports.rooms.storage.boundaryCount,896);
assert.equal(reports.rooms.storage.rollbackChecks,1664);
assert.equal(reports.network.cases.length,16);
assert.equal(reports.materials.cases.length,128);
for(const {path,sha256} of reports.rooms.sources)assert.equal(hash(await readFile(path)),sha256,`Runtime source changed: ${path}`);
async function bundle(name,options,expected,sourceExpected) {
  const result=await build({...options,write:false,metafile:true}),bytes=result.outputFiles[0].contents;
  assert.equal(hash(bytes),expected,`${name} rebuilt bytes differ`);
  const inputs=Object.keys(result.metafile.inputs).sort(),composite=createHash('sha256');
  for(const path of inputs)composite.update(path).update('\0').update(await readFile(path)).update('\0');
  const sourceSha256=composite.digest('hex');
  if(sourceExpected)assert.equal(sourceSha256,sourceExpected,`${name} source changed`);
  runtimeInputs[name]={sourceSha256,bundleSha256:expected,paths:inputs};
  artifacts.set(`${name}.js.gz`,gzipSync(bytes));
}
await bundle('contracts-browser',{entryPoints:['test/fixtures/contract-proof.ts'],bundle:true,format:'iife',globalName:'EdgefallContractProof',platform:'browser',target:'es2022'},reports.contracts.browserBundleSha256,reports.contracts.sourceSha256);
await bundle('storage-worker',{entryPoints:['test/fixtures/combat-storage-worker.ts'],bundle:true,external:['cloudflare:workers'],platform:'neutral',format:'esm'},reports.storage.workerBundleSha256,reports.storage.sourceSha256);
await bundle('material-room-browser',{entryPoints:['test/fixtures/material-room-contract.ts'],bundle:true,format:'iife',globalName:'EdgefallMaterialRoomProof',platform:'browser',target:'es2022'},reports.rooms.browserBundleSha256);
await bundle('material-room-worker',{entryPoints:['test/fixtures/material-room-storage-worker.ts'],bundle:true,external:['cloudflare:workers'],platform:'neutral',format:'esm'},reports.rooms.workerBundleSha256);
const network=[];
let workerSha,clientSha;
for(const entry of reports.network.cases) {
  const bytes=await readFile(`${entry.directory}/report.json`);assert.equal(hash(bytes),entry.reportSha256);
  const report=JSON.parse(bytes),execution=JSON.parse(await readFile(`${entry.directory}/execution.json`));
  assert.equal(report.status,'pass');assert(report.sharedSnapshots>=10);
  for(const {file,sha256} of execution.sources)assert.equal(hash(await readFile(file)),sha256,`${file} differs from network execution`);
  workerSha??=report.workerBundleSha256;clientSha??=report.bundleSha256;
  assert.equal(workerSha,report.workerBundleSha256);assert.equal(clientSha,report.bundleSha256);
  const id=entry.directory.split('/').at(-1);
  for(const file of ['report.json','execution.json','diagnostics.json','execution.log','material-before.png','material-after.png']) {
    const raw=await readFile(`${entry.directory}/${file}`),png=file.endsWith('.png');
    artifacts.set(`network-${id}-${file}${png?'':'.gz'}`,png?raw:gzipSync(raw));
  }
  network.push({...entry,scenarioId:report.materialRoom.scenarioId,eventHash:report.materialRoom.eventHash,
    players:report.room.combat.world.players.map(p=>({playerId:p.playerId,weapon:p.weapon,grenadeStock:p.grenadeStock,lives:p.lives})),
    props:report.room.combat.world.props,targets:report.room.combat.world.targets.map(t=>({id:t.enemy.body.id,health:t.health})),
    droppedFrames:report.clients.reduce((sum,c)=>sum+c.events.framesDropped,0),
    duplicates:report.clients.reduce((sum,c)=>sum+c.events.duplicates,0)});
}
await bundle('network-worker',{entryPoints:['src/worker/diagnostics/room-probe.ts'],bundle:true,external:['cloudflare:workers'],platform:'neutral',format:'esm'},workerSha);
for(const [name,expected] of [['combat-lab',reports.lab.bundleSha256],['network-lab',clientSha],['material-lab',reports.materials.bundleSha256]]) {
  const output=resolve(`dist/client/${name}.js`);assert.equal(hash(await readFile(output)),expected,`${name} tested output changed`);
  await bundle(name,{entryPoints:[resolve(`src/client/${name}.ts`)],bundle:true,format:'iife',outfile:output,platform:'browser',target:'es2022'},expected);
}
assert.equal(hash(await readFile('src/client/material-lab.html')),reports.materials.htmlSha256);
assert.equal(hash(await readFile('scripts/verify-material-lab.mjs')),reports.materials.verifierSha256);
for(const item of reports.materials.cases) {
  const portable=reports.contracts.materials.cases.find(c=>JSON.stringify(c.definition)===JSON.stringify(item.definition));
  assert(portable);assert.equal(item.finalHash,portable.finalHash);assert.equal(item.traceHash,portable.traceHash);
  const bytes=await readFile(`dist/material-lab-evidence/${item.recording.file}`);assert.equal(hash(bytes),item.recording.sha256);
  assert.equal(JSON.parse(bytes).format,2);
  artifacts.set(`material-${item.recording.file}.gz`,gzipSync(bytes));
  for(const screenshot of item.screenshots) {
    const png=await readFile(`dist/material-lab-evidence/${screenshot.file}`);assert.equal(hash(png),screenshot.sha256);
    artifacts.set(`material-${screenshot.file}`,png);
  }
}
artifacts.set('material-inspector.png',await readFile('dist/material-lab-evidence/inspector.png'));
for(const [name,path] of Object.entries({checks:'/tmp/edgefall-material-room-check.log',types:'/tmp/edgefall-material-room-worker-types.log',runtime:'/tmp/edgefall-material-room-runtimes.log',network:'/tmp/edgefall-material-room-network.log',wireControl:'/tmp/edgefall-material-room-wire-control.log',materialTests:'/tmp/edgefall-material-room-tests.log'}))artifacts.set(`${name}.log.gz`,gzipSync(await readFile(path)));
const controls=[];
for(const directory of (await readdir('/tmp')).filter(name=>/^edgefall-material-room-(?:clock-control(?:-\d+)?|build-control|upgrade-control)$/.test(name)).sort()) {
  const prefix=directory.replace('edgefall-material-room-','');
  for(const file of await readdir(`/tmp/${directory}`)) {
    const bytes=await readFile(`/tmp/${directory}/${file}`),png=file.endsWith('.png');
    artifacts.set(`${prefix}-${file}${png?'':'.gz'}`,png?bytes:gzipSync(bytes));
  }
  const result=JSON.parse(await readFile(`/tmp/${directory}/failure.json`)),room=result.room;
  controls.push({name:prefix,error:result.error,tick:room?.tick,clock:room?.clock,worldFailure:room?.worldFailure,persistenceFailure:room?.persistenceFailure});
}
const missions=[];let benchmarkSha;
for(const [players,directory,prefix] of [[1,'dist/breakwater-evidence','solo'],[2,'dist/breakwater-2-evidence','coop-2'],[4,'dist/breakwater-4-evidence','coop-4']]) {
  const bytes=await readFile(`${directory}/report.json`),report=JSON.parse(bytes);
  assert.equal(report.status,'pass');assert.equal(report.validationOnly,true);assert.equal(report.videos.length,0);assert.equal(report.outcome,'victory');assert.equal(report.supplies.claims.length,players*5);
  assert.equal(report.captureIdentity.verifierSha256,hash(await readFile('scripts/verify-breakwater.mjs')));
  assert.equal(report.captureIdentity.routeSha256,hash(await readFile('test/fixtures/breakwater-proof.ts')));
  assert.equal(report.captureIdentity.assetManifestSha256,hash(await readFile('public/assets/manifest.json')));
  benchmarkSha??=report.clientSha256;assert.equal(benchmarkSha,report.clientSha256);
  const recordingBytes=await readFile(`${directory}/${prefix}.recording.json`),recording=JSON.parse(recordingBytes),final=JSON.parse(recording.finalState);
  assert.equal(recording.format,5);assert.equal(final.format,5);assert.equal(final.combat.format,14);
  assert.equal(recording.commands.length,report.ticks);assert.equal(final.supplies.items.filter(item=>item.status==='claimed').length,players*5);
  assert(final.combat.players.every(p=>p.life==='alive'&&p.lives>0));
  missions.push({players,ticks:report.ticks,claims:report.supplies.claims.length,indicatorBoundaries:report.supplies.indicators.length,finalStateSha256:hash(Buffer.from(recording.finalState)),finalPlayers:final.combat.players.map(p=>({playerId:p.playerId,weapon:p.weapon,lives:p.lives})),supplies:final.supplies});
  artifacts.set(`mission-${players}.json.gz`,gzipSync(bytes));artifacts.set(`mission-${players}.recording.json.gz`,gzipSync(recordingBytes));
  for(const file of (await readdir(directory)).filter(file=>/-victory-(?:clean|debug)\.png$/.test(file)).sort())artifacts.set(`mission-${players}-${file}`,await readFile(`${directory}/${file}`));
}
const benchmarkOutput=resolve('dist/client/benchmark.js');assert.equal(hash(await readFile(benchmarkOutput)),benchmarkSha);
await bundle('benchmark',{entryPoints:[resolve('src/client/benchmark.ts')],bundle:true,format:'iife',outfile:benchmarkOutput,platform:'browser',target:'es2022'},benchmarkSha);
for(const [name,value] of Object.entries({networkCases:network,controls,missions,runtimeInputs}))artifacts.set(`${name}.json`,Buffer.from(JSON.stringify(value,null,2)+'\n'));
artifacts.set('curate-material-room.mjs',await readFile(import.meta.filename));
const denied=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,/\bgithub_pat_[A-Za-z0-9_]{20,}\b/,/\bBearer [A-Za-z0-9_\-.]{20,}/i,/\b(?:access_token|refresh_token|api_token)\s*[=:]\s*["'][A-Za-z0-9_\-.]{20,}/i];
const deniedKeys=/^(?:authorization|cookie|cookies|set-cookie|token|apiToken|api_token|accessToken|access_token|refresh_token|profileSecret|profileCookieSecret|resumeClaim|admissionClaim)$/i;
function scan(value,path='root') {
  if(!value||typeof value!=='object')return;
  for(const [key,child] of Object.entries(value)){assert(!deniedKeys.test(key),`Credential-like report field at ${path}.${key}`);scan(child,`${path}.${key}`);}
}
for(const [path,bytes] of artifacts)if(!path.endsWith('.png')) {
  const plain=(path.endsWith('.gz')?gunzipSync(bytes):bytes).toString();assert(!denied.some(pattern=>pattern.test(plain)),`Credential pattern in ${path}`);
  if(/\.json(?:\.gz)?$/.test(path))scan(JSON.parse(plain),path);
}
const allInputs=Object.values(runtimeInputs).flatMap(item=>item.paths);
const sourcePaths=[...new Set([...allInputs.filter(path=>!path.startsWith('node_modules/')),...execFileSync('rg',['--files','src','test','scripts','e2e','package.json','pnpm-lock.yaml','mise.toml','vitest.config.ts','tsconfig.json','wrangler.jsonc','worker-configuration.d.ts','public/assets/manifest.json'],{encoding:'utf8'}).trim().split('\n')])].sort();
const fingerprint=async path=>{const bytes=await readFile(path);return {path,bytes:bytes.length,sha256:hash(bytes)};};
const sources=await Promise.all(sourcePaths.map(fingerprint)),dependencies=await Promise.all([...new Set(allInputs.filter(path=>path.startsWith('node_modules/')))].sort().map(fingerprint));
const manifest={format:1,baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'Registered material-room integration: 128 cases in Node/Chromium/workerd, 384 exact archive/journal continuations, 896 cold SQLite boundaries and 1664 rollback checks. Sixteen representative keyboard network cases retain dropped/duplicated event evidence and all observed clock/build/harness failures. Nine rebuilt bundles match tested bytes. Full W07, final media, production v3, deployed cadence and trace ingestion remain open.',runtimeInputs:Object.fromEntries(Object.entries(runtimeInputs).map(([name,{paths,...identity}])=>[name,identity])),sources,dependencies,artifacts:[]};
await mkdir(destination);
for(const [path,bytes] of artifacts){await writeFile(`${destination}/${path}`,bytes);manifest.artifacts.push({path,bytes:bytes.length,sha256:hash(bytes)});}
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(`${destination}/artifacts.json`,bytes);
console.log(JSON.stringify({destination,sources:sources.length,dependencies:dependencies.length,artifacts:manifest.artifacts.length,bytes:manifest.artifacts.reduce((sum,a)=>sum+a.bytes,0),manifestSha256:hash(bytes),network:network.map(({definition,sharedSnapshots,droppedFrames})=>({definition,sharedSnapshots,droppedFrames})),controls,missions:missions.map(({players,ticks,indicatorBoundaries})=>({players,ticks,indicatorBoundaries}))}));

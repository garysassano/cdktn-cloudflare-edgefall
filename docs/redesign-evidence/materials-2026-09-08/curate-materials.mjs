import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
const {build}=createRequire(resolve('package.json'))('esbuild');
const destination='docs/redesign-evidence/materials-2026-09-08';
await assert.rejects(access(destination),'Preserve existing evidence packages');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const paths={contracts:'dist/contract-runtime-proof/report.json',storage:'dist/combat-storage-proof/report.json',lab:'dist/combat-lab-evidence/report.json',materials:'dist/material-lab-evidence/report.json',network:'dist/network-combat-support-evidence/report.json'};
const reports={};
for(const [name,path] of Object.entries(paths)) {
  reports[name]=JSON.parse(await readFile(path));assert.equal(reports[name].status,'pass',name);
}
assert.equal(reports.contracts.materials.cases.length,128);
assert.equal(reports.contracts.materials.cases.reduce((sum,item)=>sum+item.checkpoints.length,0),384);
assert.equal(reports.materials.cases.length,128);
assert.equal(reports.materials.cases.reduce((sum,item)=>sum+item.geometryBoundaries.length,0),1234);
assert.equal(reports.storage.support.boundaries.length,11);
assert.equal(reports.network.clients.length,4);assert(reports.network.sharedSnapshots>=10);
for(const item of reports.materials.cases) {
  const portable=reports.contracts.materials.cases.find(candidate=>JSON.stringify(candidate.definition)===JSON.stringify(item.definition));
  assert(portable,'Missing portable material definition');
  assert.equal(item.finalHash,portable.finalHash);assert.equal(item.traceHash,portable.traceHash);
  assert.equal(item.recording.contentFingerprint,portable.recordingFingerprint);
}
const networkExecution=JSON.parse(await readFile('dist/network-combat-support-evidence/execution.json'));
for(const {file,sha256} of networkExecution.sources)assert.equal(hash(await readFile(file)),sha256,`${file} differs from network execution`);
const runtimeInputs={},artifacts=new Map();
async function bundle(name,options,expected,compositeExpected) {
  const result=await build({...options,write:false,metafile:true}),bytes=result.outputFiles[0].contents;
  assert.equal(hash(bytes),expected,`${name} rebuilt bytes differ`);
  const inputs=Object.keys(result.metafile.inputs).sort(),composite=createHash('sha256');
  for(const path of inputs)composite.update(path).update('\0').update(await readFile(path)).update('\0');
  const sourceSha256=composite.digest('hex');
  if(compositeExpected)assert.equal(sourceSha256,compositeExpected,`${name} source changed`);
  runtimeInputs[name]={sourceSha256,bundleSha256:expected,paths:inputs};artifacts.set(`${name}.js.gz`,gzipSync(bytes));
}
await bundle('contracts-browser',{entryPoints:['test/fixtures/contract-proof.ts'],bundle:true,format:'iife',globalName:'EdgefallContractProof',platform:'browser',target:'es2022'},reports.contracts.browserBundleSha256,reports.contracts.sourceSha256);
await bundle('storage-worker',{entryPoints:['test/fixtures/combat-storage-worker.ts'],bundle:true,external:['cloudflare:workers'],platform:'neutral',format:'esm'},reports.storage.workerBundleSha256,reports.storage.sourceSha256);
await bundle('network-worker',{entryPoints:['src/worker/diagnostics/room-probe.ts'],bundle:true,external:['cloudflare:workers'],platform:'neutral',format:'esm'},reports.network.workerBundleSha256);
for(const [name,expected] of [['combat-lab',reports.lab.bundleSha256],['network-lab',reports.network.bundleSha256],['material-lab',reports.materials.bundleSha256]]) {
  const output=resolve(`dist/client/${name}.js`);assert.equal(hash(await readFile(output)),expected,`${name} tested output changed`);
  await bundle(name,{entryPoints:[resolve(`src/client/${name}.ts`)],bundle:true,format:'iife',outfile:output,platform:'browser',target:'es2022'},expected);
}
assert.equal(hash(await readFile('src/client/material-lab.html')),reports.materials.htmlSha256);
assert.equal(hash(await readFile('scripts/verify-material-lab.mjs')),reports.materials.verifierSha256);
for(const [name,path] of Object.entries(paths))artifacts.set(`${name}.json.gz`,gzipSync(await readFile(path)));
artifacts.set('material-cases.json',Buffer.from(JSON.stringify(reports.contracts.materials,null,2)+'\n'));
for(const [name,path] of [
  ['checks','/tmp/edgefall-material-check.log'],
  ['checks-timeout-control','/tmp/edgefall-material-check-timeout-control.log'],
  ['checks-contention-control','/tmp/edgefall-material-check-contention-control.log'],
  ['foot-regression','/tmp/edgefall-material-foot-regression.log'],
  ['material-tests','/tmp/edgefall-material-tests.log'],
  ['solid-face-regression-control','/tmp/edgefall-material-regression.log'],
  ['solid-face-regression','/tmp/edgefall-material-regression-face.log'],
])artifacts.set(`${name}.log.gz`,gzipSync(await readFile(path)));
for(const item of reports.materials.cases) {
  const bytes=await readFile(`dist/material-lab-evidence/${item.recording.file}`);assert.equal(hash(bytes),item.recording.sha256);
  artifacts.set(`material-${item.recording.file}.gz`,gzipSync(bytes));
  for(const screenshot of item.screenshots) {
    const png=await readFile(`dist/material-lab-evidence/${screenshot.file}`);assert.equal(hash(png),screenshot.sha256);
    artifacts.set(`material-${screenshot.file}`,png);
  }
}
artifacts.set('material-inspector.png',await readFile('dist/material-lab-evidence/inspector.png'));
for(const file of (await readdir('dist/combat-lab-evidence')).filter(f=>/^support-\d+\.(png|json)$/.test(f)).sort()) {
  const bytes=await readFile(`dist/combat-lab-evidence/${file}`);
  artifacts.set(`lab-${file}${file.endsWith('.json')?'.gz':''}`,file.endsWith('.json')?gzipSync(bytes):bytes);
}
for(const file of ['support-damaged.png','support-falling.png','diagnostics.json','execution.json']) {
  const bytes=await readFile(`dist/network-combat-support-evidence/${file}`);
  artifacts.set(`network-${file}${file.endsWith('.json')?'.gz':''}`,file.endsWith('.json')?gzipSync(bytes):bytes);
}
for(const file of ['diagnostics.json','execution.json','failure.json','output.log']) {
  const bytes=await readFile(`/tmp/edgefall-material-network-pickup-control/${file}`);
  artifacts.set(`network-retirement-control-${file}.gz`,gzipSync(bytes));
}
let benchmarkSha;
const missions=[];
for(const [players,directory,prefix] of [[1,'dist/breakwater-evidence','solo'],[2,'dist/breakwater-2-evidence','coop-2'],[4,'dist/breakwater-4-evidence','coop-4']]) {
  const reportBytes=await readFile(`${directory}/report.json`),report=JSON.parse(reportBytes);
  assert.equal(report.status,'pass');assert.equal(report.validationOnly,true);assert.equal(report.videos.length,0);assert.equal(report.outcome,'victory');assert.equal(report.supplies.claims.length,players*5);
  assert.equal(report.captureIdentity.verifierSha256,hash(await readFile('scripts/verify-breakwater.mjs')));
  assert.equal(report.captureIdentity.routeSha256,hash(await readFile('test/fixtures/breakwater-proof.ts')));
  assert.equal(report.captureIdentity.assetManifestSha256,hash(await readFile('public/assets/manifest.json')));
  benchmarkSha??=report.clientSha256;assert.equal(report.clientSha256,benchmarkSha);
  const recordingBytes=await readFile(`${directory}/${prefix}.recording.json`),recording=JSON.parse(recordingBytes),final=JSON.parse(recording.finalState);
  assert.equal(recording.format,4);assert.equal(final.format,4);assert.equal(final.combat.format,13);
  assert.equal(recording.commands.length,report.ticks);assert.equal(final.supplies.tick,report.ticks);
  assert.equal(final.supplies.items.filter(item=>item.status==='claimed').length,players*5);assert(final.combat.players.every(p=>p.life==='alive'&&p.lives>0));
  missions.push({players,ticks:report.ticks,claims:report.supplies.claims,indicatorBoundaries:report.supplies.indicators.length,screenshots:report.screenshots.length,finalStateSha256:hash(Buffer.from(recording.finalState)),finalPlayers:final.combat.players.map(p=>({playerId:p.playerId,weapon:p.weapon,lives:p.lives})),supplies:final.supplies});
  artifacts.set(`mission-${players}.json.gz`,gzipSync(reportBytes));artifacts.set(`mission-${players}.recording.json.gz`,gzipSync(recordingBytes));
  for(const file of (await readdir(directory)).filter(file=>/-victory-(?:clean|debug)\.png$/.test(file)).sort())artifacts.set(`mission-${players}-${file}`,await readFile(`${directory}/${file}`));
}
const benchmarkOutput=resolve('dist/client/benchmark.js');assert.equal(hash(await readFile(benchmarkOutput)),benchmarkSha);
await bundle('benchmark',{entryPoints:[resolve('src/client/benchmark.ts')],bundle:true,format:'iife',outfile:benchmarkOutput,platform:'browser',target:'es2022'},benchmarkSha);
artifacts.set('mission-results.json',Buffer.from(JSON.stringify(missions,null,2)+'\n'));
artifacts.set('runtime-inputs.json',Buffer.from(JSON.stringify(runtimeInputs,null,2)+'\n'));
artifacts.set('curate-materials.mjs',await readFile(import.meta.filename));
const denied=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,/\bgithub_pat_[A-Za-z0-9_]{20,}\b/,/\bBearer [A-Za-z0-9_\-.]{20,}/i,/\b(?:access_token|refresh_token|api_token)\s*[=:]\s*["'][A-Za-z0-9_\-.]{20,}/i];
for(const [path,bytes] of artifacts)if(!path.endsWith('.png')) {
  const plain=(path.endsWith('.gz')?gunzipSync(bytes):bytes).toString();assert(!denied.some(pattern=>pattern.test(plain)),`Credential pattern in ${path}`);
}
const deniedKeys=/^(?:authorization|cookie|cookies|set-cookie|token|apiToken|api_token|accessToken|access_token|refresh_token|profileSecret|profileCookieSecret|resumeClaim|admissionClaim)$/i;
function scan(value,path='root') {
  if(!value||typeof value!=='object')return;
  for(const [key,child] of Object.entries(value)){assert(!deniedKeys.test(key),`Credential-like report field at ${path}.${key}`);scan(child,`${path}.${key}`);}
}
for(const [path,bytes] of artifacts)if(/\.json(?:\.gz)?$/.test(path))scan(JSON.parse((path.endsWith('.gz')?gunzipSync(bytes):bytes).toString()),path);
const allInputs=Object.values(runtimeInputs).flatMap(item=>item.paths);
const sourcePaths=[...new Set([...allInputs.filter(path=>!path.startsWith('node_modules/')),...execFileSync('rg',['--files','src','test','scripts','e2e','package.json','pnpm-lock.yaml','mise.toml','vitest.config.ts','tsconfig.json','wrangler.jsonc','worker-configuration.d.ts','public/assets/manifest.json'],{encoding:'utf8'}).trim().split('\n')])].sort();
const fingerprint=async path=>{const bytes=await readFile(path);return {path,bytes:bytes.length,sha256:hash(bytes)};};
const sources=await Promise.all(sourcePaths.map(fingerprint));
const dependencies=await Promise.all([...new Set(allInputs.filter(path=>path.startsWith('node_modules/')))].sort().map(fingerprint));
const manifest={format:1,baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'Authored surface responses across all eight attack families, with 128 local material scenarios, 384 JSON continuations and 128 keyboard recordings. Seven rebuilt bundles match tested bytes. Existing diagnostic archive 16 and complete local Breakwater format 4 regression pass. Material-specific room/public snapshot/cold SQLite integration, final media, production v3, deployed cadence and live trace ingestion remain open.',runtimeInputs:Object.fromEntries(Object.entries(runtimeInputs).map(([name,{paths,...identity}])=>[name,identity])),sources,dependencies,artifacts:[]};
await mkdir(destination);
for(const [path,bytes] of artifacts){await writeFile(`${destination}/${path}`,bytes);manifest.artifacts.push({path,bytes:bytes.length,sha256:hash(bytes)});}
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(`${destination}/artifacts.json`,bytes);
console.log(JSON.stringify({destination,sources:sources.length,dependencies:dependencies.length,artifacts:manifest.artifacts.length,bytes:manifest.artifacts.reduce((sum,a)=>sum+a.bytes,0),manifestSha256:hash(bytes),missions:missions.map(({players,ticks,indicatorBoundaries})=>({players,ticks,indicatorBoundaries}))}));

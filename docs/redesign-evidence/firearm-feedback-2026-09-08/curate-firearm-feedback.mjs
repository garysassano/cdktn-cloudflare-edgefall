import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
const {build}=createRequire(resolve('package.json'))('esbuild');
const destination='docs/redesign-evidence/firearm-feedback-2026-09-08';
await assert.rejects(access(destination),'Preserve existing evidence packages');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const artifacts=new Map(),runtimeInputs={};
const contracts=JSON.parse(await readFile('dist/contract-runtime-proof/report.json'));
assert.equal(contracts.status,'pass');assert.equal(contracts.firearmFeedback.length,24);assert.equal(contracts.mixedInputRecovery.length,9);assert.equal(contracts.firearmFeedback.reduce((s,c)=>s+c.markers,0),626);
artifacts.set('contracts.json.gz',gzipSync(await readFile('dist/contract-runtime-proof/report.json')));
const group=JSON.parse(await readFile('dist/network-firearm-feedback/report.json'));
assert.equal(group.status,'pass');assert.equal(group.cases.length,6);
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

await bundle('contracts-browser',{entryPoints:['test/fixtures/contract-proof.ts'],bundle:true,format:'iife',globalName:'EdgefallContractProof',platform:'browser',target:'es2022'},contracts.browserBundleSha256,contracts.sourceSha256);
let workerSha,clientSha;
const network=[];
for(const entry of group.cases) {
  const raw=await readFile(`${entry.directory}/report.json`);assert.equal(hash(raw),entry.reportSha256);
  const report=JSON.parse(raw),execution=JSON.parse(await readFile(`${entry.directory}/execution.json`));
  assert.equal(report.status,'pass');assert(report.sharedSnapshots>=5);
  for(const {file,sha256} of execution.sources)assert.equal(hash(await readFile(file)),sha256,`Source changed: ${file}`);
  workerSha??=report.workerBundleSha256;clientSha??=report.bundleSha256;
  assert.equal(workerSha,report.workerBundleSha256);assert.equal(clientSha,report.bundleSha256);
  for(const file of ['report.json','execution.json','diagnostics.json','execution.log','feedback-delayed.png','feedback-complete.png']) {
    const bytes=await readFile(`${entry.directory}/${file}`),png=file.endsWith('.png');
    artifacts.set(`${entry.scenario}-${file}${png?'':'.gz'}`,png?bytes:gzipSync(bytes));
  }
  const first=report.feedback.delayed.map(client=>{
    const item=client.firearmFeedback.items.find(i=>i.confirmation.shotOrdinal===1&&i.markerIndex===0);
    assert(item?.state==='confirmed'&&item.presentedAtMs<item.acknowledgedAtMs&&item.lastPresentedAtMs<item.confirmedAtMs);
    return {playerId:item.confirmation.playerId,firstPresentedAtMs:item.presentedAtMs,acknowledgedAtMs:item.acknowledgedAtMs,confirmedAtMs:item.confirmedAtMs,lastPresentedAtMs:item.lastPresentedAtMs,preAckMs:item.acknowledgedAtMs-item.presentedAtMs,confirmationDelayMs:item.confirmedAtMs-item.bornAtMs};
  });
  network.push({...entry,roomScenario:report.room.combat.world.scenario,tick:report.room.tick,first,droppedFrames:report.clients.reduce((s,c)=>s+c.events.framesDropped,0),duplicates:report.clients.reduce((s,c)=>s+c.events.duplicates,0),counts:report.clients.map(c=>{const {items,...counts}=c.firearmFeedback;return counts;})});
}
await bundle('network-worker',{entryPoints:['src/worker/diagnostics/room-probe.ts'],bundle:true,external:['cloudflare:workers'],platform:'neutral',format:'esm'},workerSha);
await bundle('network-lab',{entryPoints:[resolve('src/client/network-lab.ts')],bundle:true,format:'iife',outfile:resolve('dist/client/network-lab.js'),platform:'browser',target:'es2022'},clientSha);
const baselineDirectory='dist/network-combat-baseline-evidence';
const baseline=JSON.parse(await readFile(`${baselineDirectory}/report.json`));
assert.equal(baseline.status,'pass');assert.equal(baseline.workerBundleSha256,workerSha);assert.equal(baseline.bundleSha256,clientSha);
for(const file of await readdir(baselineDirectory)) {
  if(!/\.(?:json|png)$/.test(file)||file.includes('failure')||file.includes('failed'))continue;
  const bytes=await readFile(`${baselineDirectory}/${file}`),png=file.endsWith('.png');
  artifacts.set(`baseline-${file}${png?'':'.gz'}`,png?bytes:gzipSync(bytes));
}
artifacts.set('baseline.log.gz',gzipSync(await readFile('/tmp/edgefall-feedback-baseline.log')));
const controls=[];
for(const directory of ['edgefall-feedback-journal-control','edgefall-feedback-hostile-control','edgefall-feedback-prop-control','edgefall-feedback-clock-control']) {
  for(const file of await readdir(`/tmp/${directory}`)) {
    const bytes=await readFile(`/tmp/${directory}/${file}`),png=file.endsWith('.png');
    artifacts.set(`${directory}-${file}${png?'':'.gz'}`,png?bytes:gzipSync(bytes));
  }
  const result=JSON.parse(await readFile(`/tmp/${directory}/failure.json`));
  controls.push({name:directory,error:result.error,tick:result.room?.tick,clock:result.room?.clock,worldFailure:result.room?.worldFailure,persistenceFailure:result.room?.persistenceFailure});
}
controls.push({name:'unit-acknowledgment-time-control',error:'The first focused test expected acknowledgedAtMs 20 and received 32. Promotion reset the timestamp; corrected to preserve the first acknowledgment.'});
for(const [name,path] of Object.entries({checks:'/tmp/edgefall-firearm-feedback-check.log',focused:'/tmp/edgefall-feedback-focused.log',network:'/tmp/edgefall-feedback-network.log',contracts:'/tmp/edgefall-feedback-contracts.log'}))artifacts.set(`${name}.log.gz`,gzipSync(await readFile(path)));
for(const [name,value] of Object.entries({network,controls,runtimeInputs}))artifacts.set(`${name}.json`,Buffer.from(JSON.stringify(value,null,2)+'\n'));
artifacts.set('curate-firearm-feedback.mjs',await readFile(import.meta.filename));
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

const manifest={format:1,baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'Shared foot firearm prediction with bounded cosmetic confirmation. Six four-browser material scenarios verify pre-acknowledgment rendered flashes and late confirmation without replay, plus moving fire. Node/workerd/Chromium compare six families in original and material solo/four-player kernels and nine mixed-edge cold journal cases. All failures retained. Production v3, final media, the broad impairment matrix, deployed timing and trace ingestion remain open.',runtimeInputs:Object.fromEntries(Object.entries(runtimeInputs).map(([name,{paths,...identity}])=>[name,identity])),sources,dependencies,artifacts:[]};
await mkdir(destination);
for(const [path,bytes] of artifacts){await writeFile(`${destination}/${path}`,bytes);manifest.artifacts.push({path,bytes:bytes.length,sha256:hash(bytes)});}
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(`${destination}/artifacts.json`,bytes);
console.log(JSON.stringify({destination,sources:sources.length,artifacts:manifest.artifacts.length,bytes:manifest.artifacts.reduce((s,a)=>s+a.bytes,0),manifestSha256:hash(bytes),network:network.map(({scenario,tick,sharedSnapshots,droppedFrames,duplicates,first,counts})=>({scenario,tick,sharedSnapshots,droppedFrames,duplicates,first,counts})),controls}));

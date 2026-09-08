import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
const {build}=createRequire(resolve('package.json'))('esbuild');
const destination='docs/redesign-evidence/tank-special-2026-09-08';
await assert.rejects(access(destination),'Preserve existing evidence packages');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const artifacts=new Map(),runtimeInputs={};
const json=async path=>JSON.parse(await readFile(path));
const contracts=await json('dist/contract-runtime-proof/report.json');
const storage=await json('dist/combat-storage-proof/report.json');
const network=await json('dist/network-combat-special-evidence/report.json');
const lab=await json('dist/combat-lab-evidence/report.json');
for(const report of [contracts,storage,network,lab])assert.equal(report.status,'pass');
assert.deepEqual(contracts.tankSpecial.cases.map(c=>c.checkpoints.length),[13,13]);
assert.equal(storage.special.boundaries.length,14);
assert.equal(lab.special.restoredTicks.length,5);
assert(network.sharedSnapshots>=10);
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
await bundle('storage-worker',{entryPoints:['test/fixtures/combat-storage-worker.ts'],bundle:true,external:['cloudflare:workers'],platform:'neutral',format:'esm'},storage.workerBundleSha256,storage.sourceSha256);
await bundle('network-worker',{entryPoints:['src/worker/diagnostics/room-probe.ts'],bundle:true,external:['cloudflare:workers'],platform:'neutral',format:'esm'},network.workerBundleSha256);
for(const [name,expected] of [['network-lab',network.bundleSha256],['combat-lab',lab.bundleSha256]])
  await bundle(name,{entryPoints:[resolve(`src/client/${name}.ts`)],bundle:true,format:'iife',outfile:resolve(`dist/client/${name}.js`),platform:'browser',target:'es2022'},expected);
for(const [name,path] of [['contracts','dist/contract-runtime-proof/report.json'],['storage','dist/combat-storage-proof/report.json']])artifacts.set(`${name}.json.gz`,gzipSync(await readFile(path)));
for(const [prefix,directory,keep] of [
 ['network','dist/network-combat-special-evidence',()=>true],
 ['lab','dist/combat-lab-evidence',name=>name.startsWith('special-')||name==='report.json'],
])for(const name of await readdir(directory)) {
  if(!keep(name)||!/\.(?:json|png)$/.test(name))continue;
  const bytes=await readFile(`${directory}/${name}`),png=name.endsWith('.png');
  artifacts.set(`${prefix}-${name}${png?'':'.gz'}`,png?bytes:gzipSync(bytes));
}
for(const name of ['focused','check-initial','check','check-final','check-cast-fixture','network','lab-initial','lab','contracts','storage'])
  artifacts.set(`${name}.log.gz`,gzipSync(await readFile(`/tmp/edgefall-special-${name}.log`)));
for(const name of await readdir('/tmp/edgefall-special-lab-initial-evidence')) {
  if(!name.startsWith('special-') && name!=='failure.json')continue;
  if(!/\.(?:json|png)$/.test(name))continue;
  const bytes=await readFile(`/tmp/edgefall-special-lab-initial-evidence/${name}`),png=name.endsWith('.png');
  artifacts.set(`initial-lab-${name}${png?'':'.gz'}`,png?bytes:gzipSync(bytes));
}
const controls=[
 {name:'cast-regression-fixture',reason:'The new presentation test initially omitted the existing p1/ atlas namespace from its expected wreck frame. The expectation now uses the real exported frame key; the failed log is retained.'},
 {name:'native-charge-review',reason:'Final review found the candidate cast mapping treated destroying as a wreck. It now keeps the released hull and tread animation until the terminal wreck; a real recorded-state presentation regression covers it. No new media was produced.'},
 {name:'initial-schema-integration',reason:'Required special fields and old wire/recording constants were updated through the TypeScript and protocol fixtures. The material recording exact-key validator also needed specialPressed.'},
 {name:'initial-fixtures',reason:'The kill counter field is count, and custom geometry must still observe living encounter members. A test used a nonexistent material name; the registered ID is open-grating. These were harness corrections.'},
 {name:'wall-occlusion-regression',reason:'A feet-origin blast could graze beneath a concrete wall. The implementation now uses the hull center; tests cover moving concrete and open-grating, moving grouped enemy hurtboxes and friendly exclusion. The failed focused log is retained.'},
 {name:'first-required-check',reason:'Two old synthetic wire byte counts, the occupied-destroying fixture and material command exact-key validator failed. All five failures are retained; final check passes 878 tests.'},
 {name:'initial-inspector-life-assumption',reason:'The driver safely ejects at tick 62 and retains three lives through 98, then an already released rifle bullet kills them at tick 109. The inspector now checks both events and the final two-life state explicitly. The failed log, screenshots and recording exports are retained.'},
];
const phases=['boarding','occupied','defeated','arming','canceled','rearmed','released','spent','final'];
const summary={
 checks:{tests:878,files:80},
 contracts:{durationsMs:contracts.durationsMs,resultSha256:contracts.resultSha256,cases:contracts.tankSpecial.cases.map(c=>({players:c.players,ticks:c.ticks,duplicates:c.duplicates,checkpoints:c.checkpoints.length,finalHash:c.finalHash,traceHash:c.traceHash,blasts:c.blasts.map(b=>({tick:b.tick,ownerId:b.ownerId})),tanks:c.tanks.map(t=>({id:t.body.id,armor:t.armor,special:t.special})),lives:c.playersFinal.map(p=>p.lives)}))},
 sqlite:{boundaries:storage.special.boundaries.length,ticks:storage.special.boundaries.map(b=>b.tick),maxArchiveRows:Math.max(...storage.special.boundaries.map(b=>b.saved.archiveRows))},
 inspector:{restoredTicks:lab.special.restoredTicks,lifeBoundaries:lab.special.boundaries.filter(b=>[62,98,109,130].includes(b.tick)).map(b=>({tick:b.tick,lives:b.players[0].lives,life:b.players[0].life,lifeStartTick:b.players[0].lifeStartTick})),final:lab.special.final.tanks[0].special},
 network:{tick:network.tank.final.tick,sharedSnapshots:network.sharedSnapshots,sharedEvents:network.tank.commonEvents.length,duplicates:network.tank.clients.reduce((s,c)=>s+c.events.duplicates,0),boundaries:Object.fromEntries(phases.map(k=>[k,network.tank[k].tick])),blasts:network.tank.blasts.map(e=>({tick:e.tick,ownerId:e.event.ownerId,actionInstanceId:e.event.actionInstanceId})),tanks:network.tank.final.combat.world.tanks.map(t=>({id:t.body.id,x:t.body.x,y:t.body.y,special:t.special})),lives:network.tank.final.combat.world.players.map(p=>p.lives)},
 observability:{traces:true,invocationLogs:true,sourceMaps:true,headSamplingRate:1,liveIngestionVerified:false,deployedTimingVerified:false},
};
for(const [name,value] of Object.entries({summary,controls,runtimeInputs}))artifacts.set(`${name}.json`,Buffer.from(JSON.stringify(value,null,2)+'\n'));
artifacts.set('curate-special.mjs',await readFile(import.meta.filename));
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
const manifest={format:1,baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'Dedicated tank sacrifice in deterministic combat and the authoritative diagnostic room. Hold/cancel/damage/safe-ejection, bounded charge and blast, wire/archive/journal, SQLite restart and four-browser evidence. Final W08 media/lifecycle/impairment acceptance, authored missions, production v3 and deployed cadence/trace ingestion remain open.',runtimeInputs:Object.fromEntries(Object.entries(runtimeInputs).map(([name,{paths,...identity}])=>[name,identity])),sources,dependencies,artifacts:[]};
await mkdir(destination);
for(const [path,bytes] of artifacts){await writeFile(`${destination}/${path}`,bytes);manifest.artifacts.push({path,bytes:bytes.length,sha256:hash(bytes)});}
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(`${destination}/artifacts.json`,bytes);
console.log(JSON.stringify({destination,sources:sources.length,dependencies:dependencies.length,artifacts:manifest.artifacts.length,bytes:manifest.artifacts.reduce((s,a)=>s+a.bytes,0),manifestSha256:hash(bytes),summary}));

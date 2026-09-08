import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
const {build}=createRequire(resolve('package.json'))('esbuild');
const destination='docs/redesign-evidence/tank-cannon-2026-09-08';
await assert.rejects(access(destination),'Preserve existing evidence packages');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const artifacts=new Map(),runtimeInputs={};
const json=async path=>JSON.parse(await readFile(path));
const contracts=await json('dist/contract-runtime-proof/report.json');
const storage=await json('dist/combat-storage-proof/report.json');
const network=await json('dist/network-combat-cannon-evidence/report.json');
const lab=await json('dist/combat-lab-evidence/report.json');
for(const report of [contracts,storage,network,lab])assert.equal(report.status,'pass');
assert.deepEqual(contracts.cannonCombat.cases.map(c=>c.checkpoints.length),[15,15]);
assert.equal(storage.cannon.boundaries.length,16);
assert.equal(lab.cannon.restoredTicks.length,7);
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
 ['network','dist/network-combat-cannon-evidence',()=>true],
 ['lab','dist/combat-lab-evidence',name=>name.startsWith('cannon-')||name==='report.json'],
])for(const name of await readdir(directory)) {
  if(!keep(name)||!/\.(?:json|png)$/.test(name))continue;
  const bytes=await readFile(`${directory}/${name}`),png=name.endsWith('.png');
  artifacts.set(`${prefix}-${name}${png?'':'.gz'}`,png?bytes:gzipSync(bytes));
}
for(const name of ['tsc','typecheck','tests-initial','tests','check-initial','check','check-final','network','lab','contracts','storage'])
  artifacts.set(`${name}.log.gz`,gzipSync(await readFile(`/tmp/edgefall-cannon-${name}.log`)));
const controls=[
 {name:'initial-typecheck',reason:'Required secondary state was absent from the synthetic vehicle fixture; three literal recording/handshake versions were stale.'},
 {name:'initial-cannon-tests',reason:'Tests incorrectly assumed twelve foot grenades and attack pass-through for a physical one-way surface. Foot stock is ten, and shells hit physical solids; blast occlusion uses the material table.'},
 {name:'initial-required-check',reason:'The new authored cannon definitions required regeneration of the Breakwater content digest.'},
 {name:'second-required-check',reason:'Three explicit wire fixture expectations still used the previous minor or vehicle byte count. Corrected for protocol 3.15; final full check passes 857 tests.'},
];
const envelopes=new Map();
for(const state of [...network.tank.cannonBoundaries,network.tank.defeated,network.tank.released,network.tank.final])
  for(const entry of state.combat.events)envelopes.set(entry.cursor,entry);
const cannonEvents=[...envelopes.values()].filter(e=>e.event.definitionId===19).sort((a,b)=>a.cursor-b.cursor);
assert.equal(cannonEvents.filter(e=>e.event.kind==='shot').length,8);
const summary={
 checks:{tests:857,files:79,vitestSeconds:28.75},
 contracts:{durationsMs:contracts.durationsMs,resultSha256:contracts.resultSha256,cases:contracts.cannonCombat.cases.map(c=>({players:c.players,ticks:c.ticks,duplicates:c.duplicates,checkpoints:c.checkpoints.length,finalHash:c.finalHash,traceHash:c.traceHash,explosions:c.notices.filter(n=>n.kind==='explosion').length}))},
 sqlite:{boundaries:storage.cannon.boundaries.length,ticks:storage.cannon.boundaries.map(b=>b.tick),maxArchiveRows:Math.max(...storage.cannon.boundaries.map(b=>b.saved.archiveRows))},
 inspector:{restoredTicks:lab.cannon.restoredTicks,finalAmmo:lab.cannon.final.tanks[0].secondary.ammo},
 network:{tick:network.tank.final.tick,sharedSnapshots:network.sharedSnapshots,sharedEvents:network.tank.commonEvents.length,duplicates:network.tank.clients.reduce((s,c)=>s+c.events.duplicates,0),boundaries:network.tank.cannonBoundaries.map(s=>({tick:s.tick,ammo:s.combat.world.tanks.map(t=>t.secondary.ammo)})),cannonEvents,lives:network.tank.final.combat.world.players.map(p=>p.lives)},
};
for(const [name,value] of Object.entries({summary,controls,runtimeInputs}))artifacts.set(`${name}.json`,Buffer.from(JSON.stringify(value,null,2)+'\n'));
artifacts.set('curate-cannon.mjs',await readFile(import.meta.filename));
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
const manifest={format:1,baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'Finite tank cannon in the deterministic laboratory and authoritative diagnostic room. Local input, collision, dual-hardpoint identity, wire/archive/journal, SQLite restart and four-browser evidence. Full W08 production lifecycle/media/impairment acceptance, authored missions, production v3 and deployed cadence/trace ingestion remain open.',runtimeInputs:Object.fromEntries(Object.entries(runtimeInputs).map(([name,{paths,...identity}])=>[name,identity])),sources,dependencies,artifacts:[]};
await mkdir(destination);
for(const [path,bytes] of artifacts){await writeFile(`${destination}/${path}`,bytes);manifest.artifacts.push({path,bytes:bytes.length,sha256:hash(bytes)});}
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(`${destination}/artifacts.json`,bytes);
console.log(JSON.stringify({destination,sources:sources.length,dependencies:dependencies.length,artifacts:manifest.artifacts.length,bytes:manifest.artifacts.reduce((s,a)=>s+a.bytes,0),manifestSha256:hash(bytes),summary}));

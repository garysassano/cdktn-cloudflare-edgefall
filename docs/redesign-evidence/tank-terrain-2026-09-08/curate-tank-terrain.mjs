import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {relative,resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
const {build}=createRequire(resolve('package.json'))('esbuild');
const destination='docs/redesign-evidence/tank-terrain-2026-09-08';
await assert.rejects(access(destination),'Preserve existing evidence packages');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async path=>JSON.parse(await readFile(path));
const artifacts=new Map(),runtimeInputs={};
const terrain=await json('dist/tank-terrain-proof/report.json'),execution=await json('dist/tank-terrain-proof/execution.json');
const control=await json('dist/tank-terrain-before-proof/report.json');
const network=await json('dist/network-combat-tank-connections-evidence/report.json');
for(const report of [terrain,control,network])assert.equal(report.status,'pass');
assert.equal(terrain.cases.length,28);assert(network.sharedSnapshots>=10);
const verifier=await readFile('scripts/verify-tank-terrain.mjs','utf8');
assert.equal(hash(verifier),execution.verifierSha256);
const checkLog=await readFile('/tmp/edgefall-tank-terrain-check.log','utf8');
assert.match(checkLog,/Tests\s+918 passed/);assert.match(checkLog,/Test Files\s+82 passed/);
async function bundle(name,options,expected,overrides={}){
 const result=await build({...options,write:false,metafile:true}),bytes=result.outputFiles[0].contents;
 assert.equal(hash(bytes),expected,`${name} rebuilt bytes differ`);
 const paths=Object.keys(result.metafile.inputs).sort(),source=createHash('sha256');
 for(const path of paths)source.update(path).update('\0').update(overrides[path]??(path==='<stdin>'?options.stdin.contents:await readFile(path))).update('\0');
 runtimeInputs[name]={bundleSha256:expected,sourceSha256:source.digest('hex'),paths};
 if(name==='previous-node')runtimeInputs[name].sourceOverrides={baseCommit:control.baseCommit,paths:Object.keys(overrides)};
 artifacts.set(`${name}.js.gz`,gzipSync(bytes));
}
await bundle('terrain-browser',{entryPoints:['test/fixtures/tank-terrain-proof.ts'],bundle:true,format:'iife',globalName:'EdgefallTankTerrain',platform:'browser',target:'es2022'},terrain.bundles.browser.sha256);
const stdin=verifier.match(/contents: `([\s\S]*?)`,/);assert(stdin,'Missing actual Worker entry');
await bundle('terrain-worker',{stdin:{resolveDir:process.cwd(),contents:stdin[1]},bundle:true,platform:'neutral',format:'esm'},terrain.bundles.worker.sha256);
const paths=['src/game/labs/combat.ts','src/game/labs/combat-tanks.ts'];
const originals=Object.fromEntries(await Promise.all(paths.map(async path=>[path,await readFile(`dist/tank-terrain-before-proof/${path.split('/').at(-1)}`,'utf8')])));
await bundle('previous-node',{entryPoints:['test/fixtures/tank-terrain-proof.ts'],bundle:true,platform:'neutral',format:'esm',plugins:[{name:'previous-stage-policy',setup(plugin){plugin.onLoad({filter:/combat(?:-tanks)?\.ts$/},args=>{const path=relative(process.cwd(),args.path);return originals[path]?{contents:originals[path],loader:'ts',resolveDir:resolve('src/game/labs')}:undefined;});}}]},control.bundleSha256,originals);
await bundle('network-worker',{entryPoints:['src/worker/diagnostics/room-probe.ts'],bundle:true,external:['cloudflare:workers'],platform:'neutral',format:'esm'},network.workerBundleSha256);
await bundle('network-lab',{entryPoints:[resolve('src/client/network-lab.ts')],bundle:true,format:'iife',outfile:resolve('dist/client/network-lab.js'),platform:'browser',target:'es2022'},network.bundleSha256);
for(const [prefix,directory] of [
 ['terrain','dist/tank-terrain-proof'],['previous','dist/tank-terrain-before-proof'],['network','dist/network-combat-tank-connections-evidence'],['control-canonical','/tmp/edgefall-tank-terrain-noncanonical-failure'],
])for(const name of await readdir(directory)){
 if((prefix==='terrain'||prefix==='previous')&&name.endsWith('.js'))continue;
 assert(/\.(?:json|png|js|mjs|ts)$/.test(name),`Unexpected artifact ${name}`);
 const bytes=await readFile(`${directory}/${name}`),binary=name.endsWith('.png');
 artifacts.set(`${prefix}-${name}${binary?'':'.gz'}`,binary?bytes:gzipSync(bytes));
}
for(const name of ['focused','check','runtimes','before','network','noncanonical'])artifacts.set(`${name}.log.gz`,gzipSync(await readFile(`/tmp/edgefall-tank-terrain-${name}.log`)));
const configs=await Promise.all(['wrangler.jsonc','.wrangler.deploy.json'].map(async path=>{
 const config=JSON.parse((await readFile(path,'utf8')).replace(/^\s*\/\/.*$/gmu,''));
 assert.equal(config.upload_source_maps,true);assert.deepEqual(config.observability,{enabled:true,logs:{enabled:true,invocation_logs:true,head_sampling_rate:1},traces:{enabled:true,head_sampling_rate:1}});
 return {path,upload_source_maps:true,observability:config.observability};
}));
const summary={checks:{tests:918,files:82},terrain:{runtimes:terrain.runtimes,cases:terrain.cases.length,ticks:terrain.cases.reduce((sum,item)=>sum+item.ticks,0),checkpoints:terrain.cases.reduce((sum,item)=>sum+item.checkpoints.length,0),resultSha256:terrain.resultSha256,caseResults:terrain.cases},previous:{baseCommit:control.baseCommit,expectedFailures:control.cases.filter(item=>item.expectedFailure).length,unchangedControls:control.cases.filter(item=>!item.expectedFailure).length,cases:control.cases},network:{clientTicks:network.clients.map(c=>c.snapshotTick),roomTick:network.room.tick,sharedSnapshots:network.sharedSnapshots,runEpoch:network.room.runEpoch,lives:network.room.combat.world.players.map(p=>p.lives),armor:network.room.combat.world.tanks.map(t=>t.armor),shells:network.room.combat.world.tanks.map(t=>t.secondary.ammo),worldFailure:network.room.worldFailure,persistenceFailure:network.room.persistenceFailure,clockFault:network.room.clock.fault},observability:{configs,liveIngestionVerified:false,deployedTimingVerified:false}};
const controls=[
 {name:'previous-stage-boundary',reason:'Current terrain fixtures against exact prior combat/tank source fail ten expected cases. Lower depots are destroyed before boarding; descending lifts consume lives; an earlier fall boundary reaches seated-player damage before releasing ownership. Solo/four-player ordinary step routes remain valid controls.'},
 {name:'noncanonical-observation',reason:'The initial cross-runtime report hashed an absent optional event definition as undefined. The verifier now records explicit null, preserving strict canonical validation. The failed bundle, execution record and log are retained.'},
 {name:'terrain-scope',reason:'Four-player terrain cases use separate lanes for simultaneous geometry stress, except the shared friendly crossing. These are full combat-step fixtures with deterministic terrain and authored hostile projectiles, not completed mission content, actual enemy-AI pressure, socket impairment or rendered footage. The five reconstruction boundaries per case use JSON state plus known scenario geometry; they are not SQLite/archive validation.'},
 {name:'acceptance-remaining',reason:'The existing four-browser takeover/grace/cold-SQLite proof passes again with the updated default profile. Full degraded-network vehicle footage, final visual/audio review, Harbor and the remaining campaign, production v3, stable-host/deployed cadence and live trace ingestion remain open. No clock/input guard is weakened.'},
];
for(const [name,value] of Object.entries({summary,controls,runtimeInputs}))artifacts.set(`${name}.json`,Buffer.from(JSON.stringify(value,null,2)+'\n'));
artifacts.set('curate-tank-terrain.mjs',await readFile(import.meta.filename));
const denied=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,/\bgithub_pat_[A-Za-z0-9_]{20,}\b/,/\bBearer [A-Za-z0-9_\-.]{20,}/i,/\b(?:access_token|refresh_token|api_token)\s*[=:]\s*["'][A-Za-z0-9_\-.]{20,}/i];
const deniedKeys=/^(?:authorization|cookie|cookies|set-cookie|token|apiToken|api_token|accessToken|access_token|refresh_token|profileSecret|profileCookieSecret|resumeClaim|admissionClaim)$/i;
function scan(value,path='root'){if(!value||typeof value!=='object')return;for(const [key,child] of Object.entries(value)){assert(!deniedKeys.test(key),`Credential-like report field at ${path}.${key}`);scan(child,`${path}.${key}`);}}
for(const [path,bytes] of artifacts)if(!path.endsWith('.png')){const plain=(path.endsWith('.gz')?gunzipSync(bytes):bytes).toString();assert(!denied.some(pattern=>pattern.test(plain)),`Credential pattern in ${path}`);if(/\.json(?:\.gz)?$/.test(path))scan(JSON.parse(plain),path);}
const allInputs=Object.values(runtimeInputs).flatMap(item=>item.paths);
const sourcePaths=[...new Set([...allInputs.filter(path=>!path.startsWith('node_modules/')&&path!=='<stdin>'),...execFileSync('rg',['--files','src','test','scripts','e2e','package.json','pnpm-lock.yaml','mise.toml','vitest.config.ts','tsconfig.json','wrangler.jsonc','worker-configuration.d.ts','public/assets/manifest.json'],{encoding:'utf8'}).trim().split('\n')])].sort();
const fingerprint=async path=>{const bytes=await readFile(path);return {path,bytes:bytes.length,sha256:hash(bytes)};};
const sources=await Promise.all(sourcePaths.map(fingerprint)),dependencies=await Promise.all([...new Set(allInputs.filter(path=>path.startsWith('node_modules/')))].sort().map(fingerprint));
const manifest={format:1,baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'Stage-owned tank fall/ejection boundary with 28 full-step terrain fixtures across Node, Chromium and local workerd, prior-source controls and unchanged four-browser recovery regression. No completed mission, custom-stage SQLite, rendered/degraded footage, final media or deployed timing/trace ingestion claim.',runtimeInputs:Object.fromEntries(Object.entries(runtimeInputs).map(([name,{paths,...identity}])=>[name,identity])),sources,dependencies,artifacts:[]};
await mkdir(destination);
for(const [path,bytes] of artifacts){await writeFile(`${destination}/${path}`,bytes);manifest.artifacts.push({path,bytes:bytes.length,sha256:hash(bytes)});}
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(`${destination}/artifacts.json`,bytes);
console.log(JSON.stringify({destination,sources:sources.length,dependencies:dependencies.length,artifacts:manifest.artifacts.length,bytes:manifest.artifacts.reduce((sum,item)=>sum+item.bytes,0),manifestSha256:hash(bytes),network:summary.network}));

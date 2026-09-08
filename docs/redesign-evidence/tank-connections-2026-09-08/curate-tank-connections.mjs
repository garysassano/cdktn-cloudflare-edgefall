import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {relative,resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
const {build}=createRequire(resolve('package.json'))('esbuild');
const destination='docs/redesign-evidence/tank-connections-2026-09-08';
await assert.rejects(access(destination),'Preserve existing evidence packages');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async path=>JSON.parse(await readFile(path));
const artifacts=new Map(),runtimeInputs={};
const network=await json('dist/network-combat-tank-connections-evidence/report.json');
const execution=await json('dist/network-combat-tank-connections-evidence/execution.json');
const original=await json('/tmp/edgefall-tank-connections-seated-guard-failure/execution.json');
assert.equal(network.status,'pass');
assert(network.sharedSnapshots>=10);
for(const source of execution.sources)assert.equal(hash(await readFile(source.file)),source.sha256,`Verifier changed after run: ${source.file}`);
const checkLog=await readFile('/tmp/edgefall-tank-connections-check.log','utf8');
assert.match(checkLog,/Tests\s+890 passed/);
assert.match(checkLog,/Test Files\s+81 passed/);
const entry='src/worker/diagnostics/room-probe.ts';
const oldSource=execFileSync('git',['show',`${original.baseCommit}:${entry}`],{encoding:'utf8'});
artifacts.set('control-seated-guard-room-probe.ts.gz',gzipSync(oldSource));
async function bundle(name,options,expected,overrides={}) {
 const result=await build({...options,write:false,metafile:true}),bytes=result.outputFiles[0].contents;
 assert.equal(hash(bytes),expected,`${name} rebuilt bytes differ`);
 const paths=Object.keys(result.metafile.inputs).sort(),composite=createHash('sha256');
 for(const path of paths)composite.update(path).update('\0').update(overrides[path]??await readFile(path)).update('\0');
 runtimeInputs[name]={sourceSha256:composite.digest('hex'),bundleSha256:expected,paths,...(name==='control-seated-guard-worker'?{baseCommit:original.baseCommit,sourceOverride:{path:entry,artifact:'control-seated-guard-room-probe.ts.gz'}}:{})};
 artifacts.set(`${name}.js.gz`,gzipSync(bytes));
}
const workerOptions={entryPoints:[entry],bundle:true,external:['cloudflare:workers'],platform:'neutral',format:'esm'};
await bundle('network-worker',workerOptions,network.workerBundleSha256);
await bundle('control-seated-guard-worker',{
 ...workerOptions,
 plugins:[{name:'original-admission-guard',setup(plugin){plugin.onLoad({filter:/room-probe\.ts$/},args=>relative(process.cwd(),args.path)===entry?{contents:oldSource,loader:'ts',resolveDir:resolve('src/worker/diagnostics')}:undefined);}}],
},original.workerBundleSha256,{[entry]:oldSource});
await bundle('network-lab',{entryPoints:[resolve('src/client/network-lab.ts')],bundle:true,format:'iife',outfile:resolve('dist/client/network-lab.js'),platform:'browser',target:'es2022'},network.bundleSha256);
for(const [prefix,directory] of [
 ['network','dist/network-combat-tank-connections-evidence'],
 ['control-seated-guard','/tmp/edgefall-tank-connections-seated-guard-failure'],
 ['control-renderer-race','/tmp/edgefall-tank-connections-renderer-race-failure'],
 ['control-host-clock','/tmp/edgefall-tank-connections-clock-failure'],
])for(const name of await readdir(directory)){
 assert(/\.(?:json|png)$/.test(name),`Unexpected evidence artifact ${name}`);
 const bytes=await readFile(`${directory}/${name}`),binary=name.endsWith('.png');
 artifacts.set(`${prefix}-${name}${binary?'':'.gz'}`,binary?bytes:gzipSync(bytes));
}
for(const name of ['check','network'])artifacts.set(`${name}.log.gz`,gzipSync(await readFile(`/tmp/edgefall-tank-connections-${name}.log`)));
const configs=await Promise.all(['wrangler.jsonc','.wrangler.deploy.json'].map(async path=>{
 const config=JSON.parse((await readFile(path,'utf8')).replace(/^\s*\/\/.*$/gmu,''));
 assert.equal(config.upload_source_maps,true);
 assert.deepEqual(config.observability,{enabled:true,logs:{enabled:true,invocation_logs:true,head_sampling_rate:1},traces:{enabled:true,head_sampling_rate:1}});
 return {path,upload_source_maps:config.upload_source_maps,observability:config.observability};
}));
const boundary=name=>{const item=network.tank.boundaries.find(item=>item.name===name);assert(item,`Missing ${name}`);return item.state;};
const grace=boundary('disconnect-grace'),released=boundary('disconnect-released'),empty=boundary('empty-persisted');
const summary={
 checks:{tests:890,files:81,seatedPhases:['boarding','final boarding tick','occupied','arming','exiting','final exit tick'],waitingAndPlaying:true},
 network:{
  browser:network.browser,
  takeoverTick:network.tank.replaced[0].initialServerTick,
  boundaries:network.tank.boundaries.map(({name,state})=>({name,tick:state.tick,runEpoch:state.runEpoch,roomMode:state.roomMode})),
  grace:{observedTick:grace.tick,disconnectedTicks:grace.combat.world.tanks[0].disconnectedTicks,releaseTick:released.combat.world.tanks[0].action.stateStartTick,requiredTicks:15},
  empty:{tick:empty.tick,committedTick:empty.durability.committedTick,backlogTicks:empty.durability.backlogTicks,timerPending:empty.clock.timerPending},
  clientTicks:network.clients.map(c=>c.snapshotTick),roomTick:network.room.tick,sharedSnapshots:network.sharedSnapshots,
  runEpoch:network.room.runEpoch,connectionEpochs:network.clients.map(c=>c.connectionEpoch),controlEpochs:network.clients.map(c=>c.authoritative.controlEpoch),
  lives:network.clients.map(c=>c.authoritative.lives),armor:network.room.combat.world.tanks.map(t=>t.armor),shells:network.room.combat.world.tanks.map(t=>t.secondary.ammo),
  historicalEffectsOnColdReturn:network.tank.restored.map(c=>c.events.receipts.length),worldFailure:network.room.worldFailure,persistenceFailure:network.room.persistenceFailure,clockFault:network.room.clock.fault,
 },
 observability:{configs,liveIngestionVerified:false,deployedTimingVerified:false},
};
const controls=[
 {name:'obsolete-seated-admission-guard',reason:'The original Worker rejected seated replacement before reaching the existing simulation handoff. The first browser run never obtained a P1 replacement baseline and later stopped on a host time_regression. The original Worker source and rebuilt bundle are retained at the exact execution hash; the passing run uses the removed seat restriction and retains the generation-exhaustion guard.'},
 {name:'renderer-readiness',reason:'The next verifier read controllerNetworkLab before the replacement renderer had installed it. Waiting for the actual lab object fixes the verifier race; the failed report is retained.'},
 {name:'host-clock-and-polling',reason:'After the runtime fix, one run completed takeover and P2 reclaim but encountered fresh-baseline reconnects and a later host time_regression. The verifier then stopped copying entire accumulated recordings during every client poll. It now selects only needed fields and copies snapshot receipts once at completion. The independent passing run leaves all runtime clock and input guards unchanged. This is a bounded acceptance run, not resolution of the host clock discrepancy.'},
 {name:'scope',reason:'The change is in the authoritative diagnostic room, not the old production protocol. Six portable transfer boundaries and a real four-browser socket/SQLite restart pass. Full tank geometry and degraded-network footage, final media, production v3, stable-host/deployed cadence and live Cloudflare trace ingestion remain open.'},
];
for(const [name,value] of Object.entries({summary,controls,runtimeInputs}))artifacts.set(`${name}.json`,Buffer.from(JSON.stringify(value,null,2)+'\n'));
artifacts.set('curate-tank-connections.mjs',await readFile(import.meta.filename));
const denied=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,/\bgithub_pat_[A-Za-z0-9_]{20,}\b/,/\bBearer [A-Za-z0-9_\-.]{20,}/i,/\b(?:access_token|refresh_token|api_token)\s*[=:]\s*["'][A-Za-z0-9_\-.]{20,}/i];
const deniedKeys=/^(?:authorization|cookie|cookies|set-cookie|token|apiToken|api_token|accessToken|access_token|refresh_token|profileSecret|profileCookieSecret|resumeClaim|admissionClaim)$/i;
function scan(value,path='root'){
 if(!value||typeof value!=='object')return;
 for(const [key,child] of Object.entries(value)){assert(!deniedKeys.test(key),`Credential-like report field at ${path}.${key}`);scan(child,`${path}.${key}`);}
}
for(const [path,bytes] of artifacts)if(!path.endsWith('.png')){
 const plain=(path.endsWith('.gz')?gunzipSync(bytes):bytes).toString();assert(!denied.some(pattern=>pattern.test(plain)),`Credential pattern in ${path}`);
 if(/\.json(?:\.gz)?$/.test(path))scan(JSON.parse(plain),path);
}
const allInputs=Object.values(runtimeInputs).flatMap(item=>item.paths);
const sourcePaths=[...new Set([...allInputs.filter(path=>!path.startsWith('node_modules/')),...execFileSync('rg',['--files','src','test','scripts','e2e','package.json','pnpm-lock.yaml','mise.toml','vitest.config.ts','tsconfig.json','wrangler.jsonc','worker-configuration.d.ts','public/assets/manifest.json'],{encoding:'utf8'}).trim().split('\n')])].sort();
const fingerprint=async path=>{const bytes=await readFile(path);return {path,bytes:bytes.length,sha256:hash(bytes)};};
const sources=await Promise.all(sourcePaths.map(fingerprint)),dependencies=await Promise.all([...new Set(allInputs.filter(path=>path.startsWith('node_modules/')))].sort().map(fingerprint));
const manifest={format:1,baseCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scope:'Seated connection replacement and tank lifecycle across four keyboard clients, disconnect grace, empty pause and same-origin SQLite restart. Diagnostic room only; full geometry/degraded-network/media acceptance, production v3, stable-host/deployed timing and trace ingestion remain open.',runtimeInputs:Object.fromEntries(Object.entries(runtimeInputs).map(([name,{paths,...identity}])=>[name,identity])),sources,dependencies,artifacts:[]};
await mkdir(destination);
for(const [path,bytes] of artifacts){await writeFile(`${destination}/${path}`,bytes);manifest.artifacts.push({path,bytes:bytes.length,sha256:hash(bytes)});}
const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(`${destination}/artifacts.json`,bytes);
console.log(JSON.stringify({destination,sources:sources.length,dependencies:dependencies.length,artifacts:manifest.artifacts.length,bytes:manifest.artifacts.reduce((sum,item)=>sum+item.bytes,0),manifestSha256:hash(bytes),summary}));

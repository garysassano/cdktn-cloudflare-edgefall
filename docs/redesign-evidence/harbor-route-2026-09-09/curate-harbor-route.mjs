import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
const { build } = createRequire(resolve('package.json'))('esbuild');
const destination = 'docs/redesign-evidence/harbor-route-2026-09-09';
await assert.rejects(access(destination), 'Preserve existing evidence packages');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path));
const report = await json('dist/harbor-route-proof/report.json');
const execution = await json('dist/harbor-route-proof/execution.json');
const control = await json('dist/harbor-route-before-proof/report.json');
assert.equal(report.status, 'pass');
assert.equal(control.status, 'pass');
assert.equal(report.cases.length, 9);
const checkLog = await readFile('/tmp/edgefall-harbor-route-check.log', 'utf8');
assert.match(checkLog, /Tests\s+940 passed/);
assert.match(checkLog, /Test Files\s+83 passed/);
const verifier = await readFile('scripts/verify-harbor-route.mjs', 'utf8');
assert.equal(hash(verifier), execution.verifierSha256);
const artifacts = new Map(), runtimeInputs = {};
async function bundle(name, options, expected, overrides = {}) {
  const built = await build({ ...options, bundle: true, write: false, metafile: true });
  const bytes = built.outputFiles[0].contents;
  assert.equal(hash(bytes), expected, `${name}: tested bundle changed`);
  const paths = Object.keys(built.metafile.inputs).sort(), source = createHash('sha256');
  for (const path of paths) source.update(path).update('\0').update(overrides[path] ?? (path === '<stdin>' ? options.stdin.contents : await readFile(path))).update('\0');
  runtimeInputs[name] = { bundleSha256: expected, sourceSha256: source.digest('hex'), paths };
  if (Object.keys(overrides).length) runtimeInputs[name].sourceOverrides = { baseCommit: control.baseCommit, paths: Object.keys(overrides) };
  artifacts.set(`${name}.js.gz`, gzipSync(bytes));
}
await bundle('browser', { entryPoints: ['test/fixtures/harbor-route-proof.ts'], format: 'iife', globalName: 'EdgefallHarborRoute', platform: 'browser', target: 'es2022' }, report.bundles.browser.sha256);
const stdin = verifier.match(/contents: `([\s\S]*?)`,/);
assert(stdin);
await bundle('worker', { stdin: { resolveDir: process.cwd(), contents: stdin[1] }, platform: 'neutral', format: 'esm' }, report.bundles.worker.sha256);
const original = await readFile('dist/harbor-route-before-proof/combat.ts', 'utf8');
assert.equal(original, execFileSync('git', ['show', `${control.baseCommit}:src/game/labs/combat.ts`], { encoding: 'utf8' }));
await bundle('previous-node', { entryPoints: ['test/fixtures/harbor-route-proof.ts'], platform: 'neutral', format: 'esm', plugins: [{ name: 'previous-combat-clock', setup(plugin) { plugin.onLoad({ filter: /\/labs\/combat\.ts$/ }, args => relative(process.cwd(), args.path) === 'src/game/labs/combat.ts' ? { contents: original, loader: 'ts', resolveDir: resolve('src/game/labs') } : undefined); } }] }, control.bundleSha256, { 'src/game/labs/combat.ts': original });
for (const name of ['report.json', 'traces.json', 'execution.json']) artifacts.set(name + '.gz', gzipSync(await readFile('dist/harbor-route-proof/' + name)));
artifacts.set('previous-combat.ts.gz', gzipSync(Buffer.from(original)));
artifacts.set('previous-report.json.gz', gzipSync(await readFile('dist/harbor-route-before-proof/report.json')));
artifacts.set('previous-control.mjs', await readFile('/tmp/edgefall-harbor-before.mjs'));
for (const name of ['check', 'runtimes', 'before', 'focused']) artifacts.set(name + '.log.gz', gzipSync(await readFile(`/tmp/edgefall-harbor-route-${name}.log`)));
const configs = await Promise.all(['wrangler.jsonc', '.wrangler.deploy.json'].map(async path => {
  const config = JSON.parse((await readFile(path, 'utf8')).replace(/^\s*\/\/.*$/gmu, ''));
  assert.equal(config.upload_source_maps, true);
  assert.deepEqual(config.observability, { enabled: true, logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1 }, traces: { enabled: true, head_sampling_rate: 1 } });
  return { path, upload_source_maps: true, observability: config.observability };
}));
const summary = {
  codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  checks: { tests: 940, files: 83 },
  runtimes: report.runtimes,
  cases: report.cases,
  ticks: report.cases.reduce((sum, item) => sum + item.ticks, 0),
  continuations: report.cases.reduce((sum, item) => sum + item.continuations.length, 0),
  resultSha256: report.resultSha256,
  previousControl: control,
  observability: { configs, liveIngestionVerified: false, deployedTimingVerified: false },
};
assert.equal(summary.ticks, 49269);
assert.equal(summary.continuations, 57);
const scope = 'Harbor physical route and finite shared depot in the full combat kernel across Node, Chromium and local workerd. No authored encounters, siege boss, mission victory, automatic checkpoint progression, custom-stage SQLite, rendered/network footage, final media or deployed timing/trace ingestion claim.';
const controls = [
  { name: 'previous-one-minute-limit', detail: control.scope, expectedFailure: control.expectedFailure },
  { name: 'whole-recording-hash-bound', detail: 'The first focused run completed all route assertions but four result summaries exceeded the 100,000-node canonical limit when hashing the entire input recording. The final fixture folds each accepted input frame into a rolling hash. The passing full check covers all 22 new cases; the original focused failure log is retained. The canonical size guard is unchanged.' },
  { name: 'physical-route-scope', detail: scope },
  { name: 'remaining-acceptance', detail: 'Harbor encounter and supply activation, camera/group progression, grenadier and armored-car behavior, multipart siege engine, mission identity/persistence and presentation remain to integrate. W08 still requires rendered normal/degraded network acceptance and final media review. The W06 human review remains pending.' },
];
for (const [name, value] of Object.entries({ summary, controls, runtimeInputs })) artifacts.set(name + '.json', Buffer.from(JSON.stringify(value, null, 2) + '\n'));
artifacts.set('curate-harbor-route.mjs', await readFile(import.meta.filename));
const denied = [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/, /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, /\bBearer [A-Za-z0-9_\-.]{20,}/i, /\b(?:access_token|refresh_token|api_token)\s*[=:]\s*["'][A-Za-z0-9_\-.]{20,}/i];
const deniedKeys = /^(?:authorization|cookie|cookies|set-cookie|token|apiToken|api_token|accessToken|access_token|refresh_token|profileSecret|profileCookieSecret|resumeClaim|admissionClaim)$/i;
function scan(value, path = 'root') { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { assert(!deniedKeys.test(key), `Credential field at ${path}.${key}`); scan(child, `${path}.${key}`); } }
for (const [path, bytes] of artifacts) {
  const plain = (path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString();
  assert(!denied.some(pattern => pattern.test(plain)), `Credential pattern in ${path}`);
  if (/\.json(?:\.gz)?$/.test(path)) scan(JSON.parse(plain), path);
}
const allInputs = Object.values(runtimeInputs).flatMap(item => item.paths);
const paths = [...new Set([...allInputs.filter(path => path !== '<stdin>' && !path.startsWith('node_modules/')), ...execFileSync('rg', ['--files', 'src', 'test', 'scripts', 'e2e', 'package.json', 'pnpm-lock.yaml', 'mise.toml', 'vitest.config.ts', 'tsconfig.json', 'wrangler.jsonc', 'worker-configuration.d.ts', 'public/assets/manifest.json'], { encoding: 'utf8' }).trim().split('\n')])].sort();
const fingerprint = async path => { const bytes = await readFile(path); return { path, bytes: bytes.length, sha256: hash(bytes) }; };
const sources = await Promise.all(paths.map(fingerprint));
for (const source of sources) assert.equal(hash(execFileSync('git', ['show', `HEAD:${source.path}`])), source.sha256, `Uncommitted source ${source.path}`);
const dependencies = await Promise.all([...new Set(allInputs.filter(path => path.startsWith('node_modules/')))].sort().map(fingerprint));
const manifest = { format: 1, baseCommit: summary.codeCommit, scope, runtimeInputs: Object.fromEntries(Object.entries(runtimeInputs).map(([name, { paths, ...identity }]) => [name, identity])), sources, dependencies, artifacts: [] };
await mkdir(destination);
for (const [path, bytes] of artifacts) { await writeFile(`${destination}/${path}`, bytes); manifest.artifacts.push({ path, bytes: bytes.length, sha256: hash(bytes) }); }
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
await writeFile(`${destination}/artifacts.json`, bytes);
console.log(JSON.stringify({ destination, sources: sources.length, dependencies: dependencies.length, artifacts: artifacts.size, bytes: manifest.artifacts.reduce((sum, item) => sum + item.bytes, 0), manifestSha256: hash(bytes) }));

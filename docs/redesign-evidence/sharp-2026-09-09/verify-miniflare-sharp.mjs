import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const root = createRequire(resolve('package.json'));
const wrangler = createRequire(root.resolve('wrangler/package.json'));
const mf = createRequire(wrangler.resolve('miniflare/package.json'));
const sharp = mf('sharp');
assert.equal(sharp.versions.sharp, '0.35.4');
assert.equal(sharp.versions.heif, '1.23.2');
const input = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 64, g: 128, b: 192 } } }).avif({ lossless: true }).toBuffer();
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = wrangler('miniflare');
const worker = new Miniflare(convertV4MiniflareOptions({
  modules: true,
  script: `export default { async fetch(request, env) {
    const image = await env.IMAGES.input(request.body).transform({ width: 4, height: 4 }).output({ format: 'image/png' });
    return image.response();
  } };`,
  compatibilityDate: '2026-08-30',
  images: { binding: 'IMAGES' },
  port: 0,
  log: new Log(LogLevel.ERROR),
}));
try {
  const response = await fetch((await worker.ready).origin, { method: 'POST', headers: { 'Content-Type': 'image/avif' }, body: input });
  const output = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 200, output.toString().slice(0, 200));
  assert.equal(response.headers.get('content-type'), 'image/png');
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 4);
  assert.equal(metadata.height, 4);
  assert.equal(metadata.format, 'png');
  const decoded = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.channels, 3);
  for (let i = 0; i < decoded.data.length; i++) assert(Math.abs(decoded.data[i] - [64, 128, 192][i % 3]) <= 1);
  const report = { status: 'pass', wrangler: wrangler('./package.json').version, miniflare: mf('./package.json').version, sharp: sharp.versions.sharp, libheif: sharp.versions.heif, image: { inputFormat: 'avif', inputWidth: 8, inputHeight: 8, outputFormat: metadata.format, outputWidth: metadata.width, outputHeight: metadata.height, decodedPixelChannels: decoded.data.length, outputSha256: createHash('sha256').update(output).digest('hex') }, scope: 'Local Miniflare IMAGES binding decodes generated benign AVIF through the patched transitive Sharp/libheif, transforms it and returns verified PNG pixels. No image is added to game assets and no production binding is changed.' };
  await writeFile('/tmp/edgefall-miniflare-sharp-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await worker.dispose(); }

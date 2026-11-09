import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { HandoffStore } from '../../handoff/store.mjs';
import { batchExport } from '../batch.mjs';
import { compressPng } from '../workflow.mjs';
const sharp = createRequire(new URL('../../png-under-200k/package.json', import.meta.url))('sharp');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-batch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.local/raw'), { recursive: true });
  const png = await sharp({ create: { width: 320, height: 420, channels: 4, background: '#406080' } }).png().toBuffer();
  await fs.writeFile(path.join(root, '.local/raw/selected.png'), png);
  await fs.writeFile(path.join(root, '.local/raw/old-version.png'), png);
  return { root, png, store: new HandoffStore(root), manifest: { brief: 'Latest synthetic reference, readable text', items: [{ rawPath: '.local/raw/selected.png', outputName: '日签-1.png' }] } };
}
async function start(f, manifest = f.manifest, output = '.local/delivery/batch') {
  await fs.writeFile(path.join(f.root, '.local/batch.json'), JSON.stringify(manifest));
  return batchExport(f.root, { input: '.local/batch.json', output });
}
test('explicit batch outputs only listed PNGs at original size and resume skips unchanged successes', async t => {
  const f = await fixture(t); const first = await start(f);
  assert.equal(first.complete, true); assert.equal(first.total, 1);
  const filenames = await fs.readdir(path.join(f.root, '.local/delivery/batch'));
  assert.deepEqual(filenames.sort(), ['manifest.json', 'report.json', '日签-1.png'].sort());
  const report = await f.store.readInput(first.reportPath);
  assert.equal(report.items[0].raw.width, 320); assert.equal(report.items[0].final.width, 320); assert.equal(report.items[0].final.height, 420);
  assert.ok(report.items[0].final.bytes <= 204800);
  const target = path.join(f.root, first.pngPaths[0]); const before = await fs.stat(target);
  const resumed = await batchExport(f.root, { input: first.reportPath, resume: true });
  assert.equal(resumed.skipped, 1); assert.equal((await fs.stat(target)).mtimeMs, before.mtimeMs);
  const fromManifest = await batchExport(f.root, { input: '.local/batch.json', output: '.local/delivery/batch', resume: true });
  assert.equal(fromManifest.skipped, 1);
  await assert.rejects(() => start(f), { code: 'ALREADY_EXISTS' });
});
test('partially failed batch resumes missing input without recompressing prior success', async t => {
  const f = await fixture(t);
  f.manifest.items.push({ rawPath: '.local/raw/missing.png', outputName: '日签-2.png' });
  const first = await start(f); assert.equal(first.complete, false); assert.equal(first.failed, 1);
  await fs.writeFile(path.join(f.root, '.local/raw/missing.png'), f.png);
  const resumed = await batchExport(f.root, { input: first.reportPath, resume: true });
  assert.equal(resumed.complete, true); assert.equal(resumed.skipped, 1); assert.equal(resumed.succeeded, 2);
});
test('missing input parents fail only their item and resume after inputs arrive without creating input directories', async t => {
  const f = await fixture(t);
  const missingDirectory = path.join(f.root, '.local/not-exported/nested');
  f.manifest.items.push({ rawPath: '.local/not-exported/nested/sign.png', outputName: '日签-2.png' });
  await assert.rejects(() => f.store.localPath(f.manifest.items[1].rawPath), { code: 'INVALID_PATH' });
  const first = await start(f);
  assert.equal(first.complete, false); assert.equal(first.succeeded, 1); assert.equal(first.failed, 1);
  const report = await f.store.readInput(first.reportPath);
  assert.equal(report.items[0].status, 'complete'); assert.equal(report.items[1].status, 'failed');
  assert.equal(report.items[1].error.code, 'INVALID_PATH');
  await assert.rejects(() => fs.stat(path.join(f.root, '.local/not-exported')), { code: 'ENOENT' });
  const successfulOutput = path.join(f.root, first.pngPaths[0]); const before = await fs.stat(successfulOutput);
  await fs.mkdir(missingDirectory, { recursive: true });
  await fs.writeFile(path.join(missingDirectory, 'sign.png'), f.png);
  const resumed = await batchExport(f.root, { input: first.reportPath, resume: true });
  assert.equal(resumed.complete, true); assert.equal(resumed.skipped, 1); assert.equal(resumed.succeeded, 2);
  assert.equal((await fs.stat(successfulOutput)).mtimeMs, before.mtimeMs);
});
test('allowing missing input parents still rejects linked parents and unsafe path components', async t => {
  const f = await fixture(t);
  const elsewhere = path.join(f.root, 'elsewhere'); await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(f.root, '.local/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const rawPath of ['.local/linked/missing/sign.png', '.local/missing/../outside.png', '.local/missing/CON.png', '.local/missing/alias./sign.png']) {
    await assert.rejects(() => start(f, { items: [{ rawPath, outputName: '日签.png' }] }), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(await fs.readdir(elsewhere), []);
  await assert.rejects(() => fs.stat(path.join(f.root, '.local/missing')), { code: 'ENOENT' });
});
test('resume refreshes a stale report after acquiring the lock instead of overwriting completed work', async t => {
  const f = await fixture(t); const first = await start(f);
  const current = await f.store.readInput(first.reportPath);
  const stale = structuredClone(current); stale.items = stale.items.map(item => ({ rawPath: item.rawPath, outputName: item.outputName, status: 'pending' }));
  const readInput = HandoffStore.prototype.readInput;
  let reads = 0;
  HandoffStore.prototype.readInput = async function(relative) {
    if (relative === first.reportPath && reads++ === 0) return stale;
    return readInput.call(this, relative);
  };
  t.after(() => { HandoffStore.prototype.readInput = readInput; });
  const resumed = await batchExport(f.root, { input: first.reportPath, resume: true });
  assert.equal(resumed.complete, true); assert.equal(resumed.skipped, 1);
  const saved = await readInput.call(f.store, first.reportPath);
  assert.equal(saved.items[0].final.sha256, current.items[0].final.sha256);
  assert.equal(saved.items[0].status, 'complete');
});
test('changed inputs, damaged completed outputs and changed manifests never reuse old results', async t => {
  const f = await fixture(t); const first = await start(f);
  await fs.appendFile(path.join(f.root, '.local/raw/selected.png'), 'changed');
  const changed = await batchExport(f.root, { input: first.reportPath, resume: true });
  assert.equal(changed.complete, false);
  assert.equal((await f.store.readInput(first.reportPath)).items[0].error.code, 'INPUT_CHANGED');
  await fs.writeFile(path.join(f.root, '.local/raw/selected.png'), f.png);
  await fs.writeFile(path.join(f.root, first.pngPaths[0]), 'damaged');
  const damaged = await batchExport(f.root, { input: first.reportPath, resume: true });
  assert.equal(damaged.complete, false);
  assert.equal((await f.store.readInput(first.reportPath)).items[0].error.code, 'OUTPUT_DAMAGED');
  assert.equal(await fs.readFile(path.join(f.root, first.pngPaths[0]), 'utf8'), 'damaged');
  f.manifest.brief = 'Changed latest reference'; await fs.writeFile(path.join(f.root, '.local/batch.json'), JSON.stringify(f.manifest));
  await assert.rejects(() => batchExport(f.root, { input: '.local/batch.json', output: '.local/delivery/batch', resume: true }), { code: 'MANIFEST_CHANGED' });
});
test('duplicate and unsafe output names or raw paths are rejected', async t => {
  const f = await fixture(t);
  for (const outputName of ['../outside.png', 'sub/file.png', 'sub\\file.png', 'CON.png', 'bad:stream.png', 'bad .png.']) {
    await assert.rejects(() => start(f, { items: [{ rawPath: '.local/raw/selected.png', outputName }] }));
  }
  await assert.rejects(() => start(f, { items: [{ rawPath: '.local/raw/selected.png', outputName: 'same.png' }, { rawPath: '.local/raw/old-version.png', outputName: 'SAME.png' }] }), { code: 'DUPLICATE_OUTPUT' });
  await assert.rejects(() => start(f, { items: [{ rawPath: '.local/../outside.png', outputName: 'valid.png' }] }));
});
test('oversized PNG reports compression failure rather than silently resizing', async () => {
  const png = await sharp(randomBytes(1024 * 1024 * 4), { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer();
  await assert.rejects(() => compressPng(png), { code: 'COMPRESSION_FAILED' });
});

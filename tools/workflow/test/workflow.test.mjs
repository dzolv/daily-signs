import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { HandoffStore } from '../../handoff/store.mjs';
import { ConsentStore } from '../../setup/consent.mjs';
import { acknowledgePermissionsNotice } from '../../setup/permissions-notice.mjs';
import { saveExport, snapshot, compareSnapshots, preflight } from '../workflow.mjs';
import { main } from '../cli.mjs';

const sharp = createRequire(new URL('../../png-under-200k/package.json', import.meta.url))('sharp');
const scope = { accountRef: 'synthetic-account', documentRef: 'synthetic-document', nodeRefs: ['synthetic-node'], actions: ['read'], tools: ['query_nodes'], localPaths: [], purpose: 'Synthetic observation' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-workflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.local/input'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools/png-under-200k'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  await fs.writeFile(path.join(root, 'tools/png-under-200k/package.json'), '{}');
  const png = await sharp({ create: { width: 24, height: 16, channels: 4, background: '#7f8faa' } }).png().toBuffer();
  return { root, png, store: new HandoffStore(root), output: '.local/raw.png', final: '.local/final.png' };
}
test('complete nested MCP responses, image blocks, data URLs and stdin save decoded/compressed PNG receipts', async t => {
  const f = await fixture(t);
  const base64 = f.png.toString('base64');
  const responses = [
    { content: [{ type: 'text', text: JSON.stringify(base64) }] },
    { content: [{ type: 'text', text: JSON.stringify({ result: { image: { data: base64 } } }) }] },
    { content: [{ type: 'image', mimeType: 'image/png', data: base64 }] },
    `data:image/png;base64,${base64}`, base64,
  ];
  for (let index = 0; index < responses.length; index++) {
    const receipt = await saveExport(f.root, responses[index], { output: `.local/raw-${index}.png`, compress: `.local/final-${index}.png`, kind: 'trial' });
    assert.equal(receipt.raw.width, 24); assert.equal(receipt.raw.height, 16);
    assert.equal(receipt.raw.bytes, f.png.length); assert.match(receipt.raw.sha256, /^[a-f0-9]{64}$/);
    assert.ok(receipt.final.bytes <= 204800); assert.equal(receipt.kind, 'trial');
    assert.equal(receipt.authorizationVerified, false); assert.equal(receipt.visualReviewVerified, false);
    assert.deepEqual(await f.store.readPrivate(receipt.raw.path), f.png);
    assert.deepEqual(await f.store.readInput(receipt.receiptPath), receipt);
  }
  const logs = [];
  const code = await main(['save-export', '--input', '-', '--output', f.output], { root: f.root, stdin: Readable.from([JSON.stringify(responses[0])]), log: line => logs.push(JSON.parse(line)) });
  assert.equal(code, 0); assert.equal(logs[0].raw.width, 24);
});
test('malformed/truncated base64, truncated PNGs, remote errors and multiple images cannot create outputs', async t => {
  const f = await fixture(t);
  const other = await sharp({ create: { width: 3, height: 3, channels: 4, background: '#112233' } }).png().toBuffer();
  const bad = [
    'iVBOR!bad', 'iVBORw0KGgoAAA===', f.png.toString('base64').slice(0, -1),
    f.png.subarray(0, f.png.length - 12).toString('base64'),
    { isError: true, content: [{ type: 'text', text: f.png.toString('base64') }] },
    { content: [{ type: 'image', data: f.png.toString('base64') }, { type: 'image', data: other.toString('base64') }] },
    { content: [{ type: 'text', text: '{"url":"https://example.invalid/private-export.png"}' }] },
  ];
  for (const input of bad) await assert.rejects(() => saveExport(f.root, input, { output: f.output }));
  await assert.rejects(() => fs.stat(path.join(f.root, f.output)), { code: 'ENOENT' });
  await fs.writeFile(path.join(f.root, '.local/receipt.json'), 'existing receipt');
  await assert.rejects(() => saveExport(f.root, f.png.toString('base64'), { output: f.output, receipt: '.local/receipt.json' }), { code: 'ALREADY_EXISTS' });
  await assert.rejects(() => fs.stat(path.join(f.root, f.output)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.root, '.local/receipt.json'), 'utf8'), 'existing receipt');
});
test('existing outputs, aliases, unsafe paths and linked parents are rejected without clobbering files', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, f.final), 'existing');
  await assert.rejects(() => saveExport(f.root, f.png.toString('base64'), { output: f.output, compress: f.final }), { code: 'ALREADY_EXISTS' });
  assert.equal(await fs.readFile(path.join(f.root, f.final), 'utf8'), 'existing');
  await assert.rejects(() => fs.stat(path.join(f.root, f.output)), { code: 'ENOENT' });
  for (const output of ['.local/../escape.png', '../escape.png', 'C:/escape.png', '.local/CON.png', '.local/name.png.', '.local\\escape.png']) {
    await assert.rejects(() => saveExport(f.root, f.png.toString('base64'), { output }));
  }
  await assert.rejects(() => saveExport(f.root, f.png.toString('base64'), { output: f.output, compress: f.output }), { code: 'ALREADY_EXISTS' });
  await assert.rejects(() => fs.stat(path.join(f.root, f.output)), { code: 'ENOENT' });
  const elsewhere = path.join(f.root, 'elsewhere'); await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(f.root, '.local/link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => saveExport(f.root, f.png.toString('base64'), { output: '.local/link/export.png' }), /Symlinks and junctions/);
});
test('snapshot hash ignores key order, capture time and source version; compares actual properties and asserts allowed subtrees', async t => {
  const f = await fixture(t);
  const input = { capturedAt: '2026-01-01T00:00:00Z', sourceVersion: 'synthetic-v1', nodes: { frame: { cornerRadius: 30, width: 300, image: { crop: [0, 0, 1, 1], ref: 'synthetic-image' }, mask: { opacity: 0.15 } }, text: { characters: 'before' } } };
  await snapshot(f.root, input, '.local/before.json');
  const before = await f.store.readInput('.local/before.json');
  const ordered = { nodes: { text: { characters: 'before' }, frame: { mask: { opacity: 0.15 }, image: { ref: 'synthetic-image', crop: [0, 0, 1, 1] }, width: 300, cornerRadius: 30 } }, capturedAt: '2026-01-02T00:00:00Z', sourceVersion: 'synthetic-v2' };
  await snapshot(f.root, ordered, '.local/same.json');
  const same = await f.store.readInput('.local/same.json');
  assert.equal(before.sha256, same.sha256); assert.equal(compareSnapshots(before, same).equal, true);
  input.nodes.text.characters = 'after'; await snapshot(f.root, input, '.local/after.json');
  const after = await f.store.readInput('.local/after.json');
  assert.equal(compareSnapshots(before, after, ['/nodes/text/characters']).allowedChangesOnly, true);
  input.nodes.frame.mask.opacity = 0.2; await snapshot(f.root, input, '.local/bad.json');
  const bad = await f.store.readInput('.local/bad.json');
  const comparison = compareSnapshots(before, bad, ['/nodes/text/characters']);
  assert.equal(comparison.allowedChangesOnly, false);
  assert.deepEqual(comparison.changes.map(item => item.path), ['/nodes/frame/mask/opacity', '/nodes/text/characters']);
  assert.equal(await main(['compare', '--before', '.local/before.json', '--after', '.local/bad.json', '--allow', '/nodes/text/characters'], { root: f.root, log: () => {} }), 1);
  bad.observation.nodes.frame.cornerRadius = 0;
  assert.throws(() => compareSnapshots(before, bad), { code: 'INVALID_SNAPSHOT' });
  await assert.rejects(() => snapshot(f.root, input, '.local/before.json'), { code: 'ALREADY_EXISTS' });
});
test('preflight never treats pending, denied, revoked, expanded or absent consent as ready; due maintenance remains nonblocking', async t => {
  const f = await fixture(t);
  await acknowledgePermissionsNotice(f.root, { message: 'Synthetic explanation actually given' });
  await fs.writeFile(path.join(f.root, '.local/input/scope.json'), JSON.stringify(scope));
  const store = new ConsentStore(f.root);
  const record = await store.propose(scope);
  const options = { consent: record.id, scope: '.local/input/scope.json' };
  assert.equal((await preflight(f.root)).ready, false);
  assert.equal((await preflight(f.root, options)).ready, false);
  await store.decide(record.id, { revision: record.revision, decision: 'approved', evidence: 'Synthetic explicit user instruction' });
  const approved = await preflight(f.root, options);
  assert.equal(approved.ready, true); assert.equal(approved.remoteReady, true);
  assert.equal(approved.hostAccessVerified, false); assert.equal(approved.maintenance.due, true);
  assert.equal(approved.needsHumanAction, false);
  await fs.writeFile(path.join(f.root, '.local/input/scope.json'), JSON.stringify({ ...scope, nodeRefs: ['uncovered-synthetic-node'] }));
  assert.equal((await preflight(f.root, options)).ready, false);
  await fs.writeFile(path.join(f.root, '.local/input/scope.json'), JSON.stringify(scope));
  await store.decide(record.id, { revision: 2, decision: 'revoked', evidence: 'Synthetic user revocation' });
  assert.equal((await preflight(f.root, options)).ready, false);
  const denied = await store.propose(scope);
  await store.decide(denied.id, { revision: denied.revision, decision: 'denied', evidence: 'Synthetic user denial' });
  const result = await preflight(f.root, { ...options, consent: denied.id });
  assert.equal(result.ready, false); assert.equal(result.needsHumanAction, true);
  const local = await preflight(f.root, { localOnly: true });
  assert.equal(local.ready, true); assert.equal(local.remoteReady, null);
});

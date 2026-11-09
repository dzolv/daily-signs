import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { HandoffStore, repositoryRoot } from '../store.mjs';
const sharp = createRequire(new URL('../../png-under-200k/package.json', import.meta.url))('sharp');

const unknown = { status: 'unknown' };
const verified = { status: 'verified', evidence: 'Synthetic user-provided license receipt' };
const brief = { brief: 'Synthetic daily sign', constraints: ['Keep template positioning'], expectedOutputCount: 1, preferenceEvidence: [{ id: 'habit-1', certainty: 'inferred', observation: 'Often chooses quiet backgrounds', evidence: 'Synthetic past selections, not a confirmed preference', provenance: unknown }] };
const capture = () => ({ provider: 'figma', documentRef: 'synthetic-document', nodeRefs: ['synthetic-frame'], capturedAt: '2026-01-01T00:00:00Z', sourceVersion: 'synthetic-version-1', targetFingerprint: 'synthetic-target-layout-1', text: ['Synthetic quotation'], assets: [{ id: 'chosen', role: 'selected', artifactKind: 'source-image', sourceRef: 'synthetic-board-selection-region', source: unknown, license: verified }, { id: 'idea', role: 'reference', artifactKind: 'render', sourceRef: 'synthetic-preview', source: unknown, license: unknown }] });
async function fixture(t, initial = brief) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-handoff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.local', 'input'), { recursive: true });
  const store = new HandoffStore(root);
  let state;
  const run = async (command, input, options = {}) => { state = await store.run(command, 'sample', { revision: state?.revision, input, ...options }); return state; };
  await run('init', initial);
  return { root, store, run, get state() { return state; } };
}
async function ready(f, data = capture()) {
  await f.run('capture', data);
  await f.run('select', { assetIds: ['chosen'], basis: 'source', evidence: 'Synthetic pre-agreed board region marks this asset selected' });
}
async function files(f) {
  const png = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ccffaa' } }).png().toBuffer();
  await fs.writeFile(path.join(f.root, '.local', 'input', 'raw.png'), png);
  await fs.writeFile(path.join(f.root, '.local', 'input', 'final.png'), png);
  return { review: { text: 'Synthetic text compared', template: 'Synthetic template compared', crop: 'Synthetic crop inspected', raw2x: 'Synthetic export setting observed as 2x' }, outputs: [{ rawPath: '.local/input/raw.png', finalPath: '.local/input/final.png' }] };
}
test('full lifecycle persists observed selection, proposals, blocking/resume, and decoded delivery', async t => {
  const f = await fixture(t); await f.run('capture', capture());
  const snapshotId = f.state.snapshot.id;
  await f.run('propose', { alternatives: [{ id: 'quiet', description: 'Synthetic quiet option', assetIds: ['idea'], evidence: [{ kind: 'snapshot', id: snapshotId }, { kind: 'preference', id: 'habit-1' }] }] });
  assert.equal(f.state.selection, null);
  assert.equal(f.state.preferences[0].certainty, 'inferred');
  await f.run('select', { assetIds: ['chosen'], basis: 'source', evidence: 'Pre-agreed source region' });
  await f.run('claim', undefined, { worker: 'worker-1' });
  const owner = { worker: 'worker-1', token: f.state.activeClaim.token };
  await f.run('record', { kind: 'step', message: 'Captured existing target before editing' }, owner);
  await f.run('record', { kind: 'blocked', message: 'Waiting for local export' }, owner);
  assert.equal(f.state.phase, 'blocked');
  const reloaded = await new HandoffStore(f.root).run('handoff', 'sample');
  assert.equal(reloaded.next, 'resume'); assert.equal(reloaded.activeClaim.token, owner.token);
  await assert.rejects(() => f.run('finish', { outputs: [] }, owner), /Resume/);
  await f.run('resume', undefined, owner);
  await f.run('record', { kind: 'result', message: 'Export recorded locally' }, owner);
  await f.run('finish', await files(f), owner);
  assert.equal(f.state.phase, 'complete'); assert.equal(f.state.activeClaim, null);
  const delivery = f.state.deliveries[0];
  assert.equal(delivery.snapshotId, snapshotId); assert.equal(delivery.selectionId, f.state.selection.id);
  assert.equal(delivery.outputs[0].final.width, 8); assert.ok(delivery.outputs[0].final.bytes <= 204800);
  assert.equal(f.state.history.at(-1).command, 'finish');
});
test('stale revisions and simultaneous writes cannot lose updates; duplicate claims fail', async t => {
  const f = await fixture(t); await ready(f);
  const rev = f.state.revision;
  const results = await Promise.allSettled(['one', 'two'].map(worker => f.store.run('claim', 'sample', { revision: rev, worker })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.ok(['BUSY', 'STALE_REVISION'].includes(results.find(r => r.status === 'rejected').reason.code));
  const current = await f.store.run('status', 'sample');
  assert.equal(current.revision, rev + 1);
  await assert.rejects(() => f.store.run('claim', 'sample', { revision: current.revision, worker: 'other' }), /already owns/);
  await assert.rejects(() => f.store.run('release', 'sample', { revision: rev, worker: current.activeClaim.worker, token: current.activeClaim.token }), e => e.code === 'STALE_REVISION');
});
test('finish accepts original-size 1x evidence and preserves legacy review fields without rewriting stored facts', async t => {
  for (const legacy of [false, true]) {
    const f = await fixture(t); await ready(f); await f.run('claim', undefined, { worker: 'owner' });
    const delivery = await files(f);
    if (!legacy) delivery.review = { text: 'Readable, no obvious missing text', exportScale: 'Observed native dimensions, 1x PNG' };
    const expected = structuredClone(delivery.review);
    await f.run('finish', delivery, { worker: 'owner', token: f.state.activeClaim.token });
    assert.deepEqual(f.state.deliveries[0].review, expected);
    assert.equal(f.state.deliveries[0].outputs[0].raw.width, 8);
    assert.equal(f.state.phase, 'complete');
  }
});
test('capture ignores timestamp/unrelated source version but changed target or local bytes invalidates old worker', async t => {
  const f = await fixture(t); const pngs = await files(f); const data = capture(); data.assets[0].localPath = pngs.outputs[0].rawPath;
  await ready(f, data); await f.run('claim', undefined, { worker: 'owner' });
  const old = { worker: 'owner', token: f.state.activeClaim.token };
  const selectionId = f.state.selection.id;
  await f.run('capture', { ...data, capturedAt: '2026-01-02T00:00:00Z', sourceVersion: 'unrelated-change' });
  assert.equal(f.state.activeClaim.token, old.token); assert.equal(f.state.selection.id, selectionId);
  const changed = await sharp({ create: { width: 7, height: 8, channels: 4, background: '#abccdd' } }).png().toBuffer();
  await fs.writeFile(path.join(f.root, data.assets[0].localPath), changed);
  await assert.rejects(() => f.run('finish', pngs, old), e => e.code === 'STALE_ASSET');
  await f.run('capture', { ...data, capturedAt: '2026-01-03T00:00:00Z' });
  assert.equal(f.state.activeClaim, null); assert.equal(f.state.selection, null); assert.equal(f.state.retained.claims, 1);
  assert.equal(f.state.needsSelectionReview, true); assert.equal(f.state.priorSelection.id, selectionId);
  await assert.rejects(() => f.run('finish', pngs, old), /active claim/);
  await f.run('select', { assetIds: ['chosen'], basis: 'source', evidence: 'Fresh source selection' });
  await f.run('claim', undefined, { worker: 'new-owner' });
  assert.notEqual(f.state.activeClaim.token, old.token);
  const before = f.state.snapshot.id;
  await f.run('capture', { ...data, capturedAt: '2026-01-04T00:00:00Z', targetFingerprint: 'layout-changed' });
  assert.notEqual(f.state.snapshot.id, before); assert.equal(f.state.selection, null);
});
test('proposals cannot select references; explicit user selection and release/rerun preserve prior work', async t => {
  const f = await fixture(t); await f.run('capture', capture());
  await assert.rejects(() => f.run('select', { assetIds: ['idea'], basis: 'source', evidence: 'Model prefers idea' }), /does not mark/);
  await assert.rejects(() => f.run('select', { assetIds: ['idea'], basis: 'user', evidence: 'Model guess' }), /confirmation/);
  await f.run('select', { assetIds: ['idea'], basis: 'user', evidence: 'Synthetic user statement', confirmation: 'Synthetic user explicitly chose idea' });
  await f.run('claim', undefined, { worker: 'one' }); const owner = { worker: 'one', token: f.state.activeClaim.token };
  await f.run('record', { kind: 'step', message: 'Partial work retained' }, owner);
  await assert.rejects(() => f.run('release', undefined, { worker: 'other', token: owner.token }), /active claim/);
  await f.run('release', undefined, owner); await f.run('claim', undefined, { worker: 'two' });
  assert.equal(f.state.steps.length, 1); assert.equal(f.state.retained.claims, 2);
  assert.notEqual(f.state.activeClaim.token, owner.token);
});
test('unknown provenance stays unknown; finish requires selected rights evidence or actual user confirmation', async t => {
  const f = await fixture(t); const data = capture(); data.assets[0].license = unknown;
  await ready(f, data); assert.equal(f.state.snapshot.assets[0].source.status, 'unknown'); assert.equal(f.state.snapshot.assets[0].license.status, 'unknown');
  await f.run('claim', undefined, { worker: 'one' }); let owner = { worker: 'one', token: f.state.activeClaim.token };
  const outputs = await files(f); await assert.rejects(() => f.run('finish', outputs, owner), /licensing is unknown/);
  await f.run('select', { assetIds: ['chosen'], basis: 'source', evidence: 'Existing board choice', rightsConfirmation: { confirmedBy: 'user', statement: 'Synthetic user has rights for intended use', evidence: 'Synthetic explicit user rights statement' } });
  assert.equal(f.state.snapshot.assets[0].license.status, 'unknown');
  await f.run('claim', undefined, { worker: 'two' }); owner = { worker: 'two', token: f.state.activeClaim.token };
  await f.run('finish', outputs, owner); assert.equal(f.state.phase, 'complete');
});
test('invalid exports, missing raw association, malformed evidence and unsafe paths fail atomically', async t => {
  const f = await fixture(t); await ready(f); await f.run('claim', undefined, { worker: 'owner' });
  const owner = { worker: 'owner', token: f.state.activeClaim.token };
  const outputs = await files(f); const rev = f.state.revision;
  await fs.writeFile(path.join(f.root, '.local/input/final.png'), 'not a png');
  await assert.rejects(() => f.run('finish', { outputs: outputs.outputs }, owner), /visual review/);
  await assert.rejects(() => f.run('finish', outputs, owner));
  await assert.rejects(() => f.run('finish', { ...outputs, outputs: [{ finalPath: '.local/input/final.png' }] }, owner));
  await assert.rejects(() => f.run('finish', { ...outputs, outputs: [...outputs.outputs, ...outputs.outputs] }, owner), /count/);
  await fs.writeFile(path.join(f.root, '.local/input/final.png'), Buffer.alloc(204801));
  await assert.rejects(() => f.run('finish', outputs, owner), /204800/);
  assert.equal((await f.store.run('status', 'sample')).revision, rev);
  for (const unsafe of ['.local/../escape', '.local/.. /escape', '.local/input/CON.png', '.local/input/file.', '.local/input/file ', '../outside', '.local\\input\\raw.png', '.local/input/secret:stream', '/tmp/outside']) await assert.rejects(() => f.store.readPrivate(unsafe));
  await assert.rejects(() => f.store.run('init', '../escape', { input: brief }));
  const invalid = capture(); invalid.assets[0].license = { status: 'verified' };
  await assert.rejects(() => f.run('capture', invalid), /evidence/);
  invalid.assets[0].license = unknown; invalid.assets[0].role = 'suggested';
  await assert.rejects(() => f.run('capture', invalid), /role/);
});
test('symlink/junction store and referenced asset paths are rejected', async t => {
  const f = await fixture(t); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(f.root, '.local', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => f.store.readPrivate('.local/linked/private.png'), /Symlinks/);
  await fs.mkdir(path.join(outside, 'separate'));
  const linkedRoot = path.join(outside, 'separate');
  await fs.symlink(path.join(f.root, '.local'), path.join(linkedRoot, '.local'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => new HandoffStore(linkedRoot).run('init', 'new', { input: brief }), /Symlinks/);
});
test('claim rechecks selected local bytes and rejects stale observations without losing current selection', async t => {
  const f = await fixture(t); const outputs = await files(f); const data = capture(); data.assets[0].localPath = outputs.outputs[0].rawPath;
  await ready(f, data);
  await f.run('capture', { ...data, capturedAt: '2026-01-02T00:00:00Z' });
  const selectionId = f.state.selection.id;
  await assert.rejects(() => f.run('capture', { ...data, targetFingerprint: 'old-target', capturedAt: '2026-01-01T12:00:00Z' }), e => e.code === 'STALE_OBSERVATION');
  assert.equal((await f.store.run('status', 'sample')).selection.id, selectionId);
  await fs.writeFile(path.join(f.root, data.assets[0].localPath), 'changed bytes');
  await assert.rejects(() => f.run('claim', undefined, { worker: 'one' }), e => e.code === 'STALE_ASSET');
});
test('delivery rejects physical aliases and repeated raw/final exports', async t => {
  const f = await fixture(t); await ready(f); await f.run('claim', undefined, { worker: 'owner' });
  const owner = { worker: 'owner', token: f.state.activeClaim.token }; const outputs = await files(f);
  await fs.link(path.join(f.root, outputs.outputs[0].rawPath), path.join(f.root, '.local/input/alias.png'));
  await assert.rejects(() => f.run('finish', { ...outputs, outputs: [{ rawPath: outputs.outputs[0].rawPath, finalPath: '.local/input/alias.png' }] }, owner), /distinct physical/);
  if (process.platform === 'win32') await assert.rejects(() => f.run('finish', { ...outputs, outputs: [{ rawPath: outputs.outputs[0].rawPath, finalPath: '.local/input/RAW.png' }] }, owner), /distinct physical/);
  const multiple = await fixture(t, { ...brief, expectedOutputCount: 2 }); await ready(multiple); await multiple.run('claim', undefined, { worker: 'owner' });
  const multiOwner = { worker: 'owner', token: multiple.state.activeClaim.token }; const multiOutputs = await files(multiple);
  await fs.copyFile(path.join(multiple.root, '.local/input/raw.png'), path.join(multiple.root, '.local/input/raw-two.png'));
  await fs.copyFile(path.join(multiple.root, '.local/input/final.png'), path.join(multiple.root, '.local/input/final-two.png'));
  await assert.rejects(() => multiple.run('finish', { ...multiOutputs, outputs: [...multiOutputs.outputs, { rawPath: '.local/input/raw.png', finalPath: '.local/input/final-two.png' }] }, multiOwner), /distinct physical/);
  const finalAlias = process.platform === 'win32' ? '.local/input/FINAL.png' : '.local/input/final.png';
  await assert.rejects(() => multiple.run('finish', { ...multiOutputs, outputs: [...multiOutputs.outputs, { rawPath: '.local/input/raw-two.png', finalPath: finalAlias }] }, multiOwner), /distinct physical/);
});
test('CLI persists real commands, rejects stale writes, and provides JSON errors and human help', async t => {
  const cli = (...args) => new Promise(resolve => {
    const child = spawn(process.execPath, ['tools/handoff/cli.mjs', ...args], { cwd: repositoryRoot, windowsHide: true }); let stdout = ''; let stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; }); child.on('close', code => resolve({ code, stdout, stderr }));
  });
  const invalid = await cli('claim', 'synthetic', '--revision', 'oops');
  assert.equal(invalid.code, 1); assert.equal(JSON.parse(invalid.stdout).ok, false); assert.equal(invalid.stderr, '');
  const help = await cli('--help'); assert.equal(help.code, 0); assert.match(help.stdout, /no external connections/);
  const job = `synthetic-cli-${randomUUID()}`;
  const relative = `.local/input/${job}/brief.json`;
  const realStore = new HandoffStore(repositoryRoot);
  const inputPath = await realStore.localPath(relative, { createParents: true });
  await fs.writeFile(inputPath, JSON.stringify(brief));
  t.after(async () => {
    await fs.rm(path.dirname(inputPath), { recursive: true, force: true });
    await fs.rm(path.join(repositoryRoot, '.local', 'handoff', job), { recursive: true, force: true });
  });
  const initialized = await cli('init', job, '--input', relative);
  assert.equal(initialized.code, 0); assert.equal(JSON.parse(initialized.stdout).revision, 1);
  assert.equal(typeof JSON.parse(initialized.stdout).maintenance.due, 'boolean');
  assert.equal(initialized.stderr, '');
  const snapPath = `.local/input/${job}/snapshot.json`;
  await fs.writeFile(await realStore.localPath(snapPath), JSON.stringify(capture()));
  const captured = await cli('capture', job, '--revision', '1', '--input', snapPath);
  assert.equal(captured.code, 0); assert.equal(JSON.parse(captured.stdout).snapshot.provider, 'figma');
  assert.equal(JSON.parse(captured.stdout).maintenance, undefined);
  const stale = await cli('capture', job, '--revision', '1', '--input', snapPath);
  assert.equal(stale.code, 1); assert.equal(JSON.parse(stale.stdout).error.code, 'STALE_REVISION');
  const handoff = await cli('handoff', job); assert.equal(JSON.parse(handoff.stdout).revision, 2);
  assert.equal(typeof JSON.parse(handoff.stdout).maintenance.due, 'boolean');
});

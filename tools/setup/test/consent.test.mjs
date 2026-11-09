import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConsentStore } from '../consent.mjs';

const execute = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = path.join(repoRoot, '.local/consent-tests');
const scope = () => ({ accountRef: 'synthetic-personal-account', documentRef: 'synthetic-test-copy', nodeRefs: ['synthetic-board', 'synthetic-signature'], actions: ['read', 'edit', 'export', 'local-write'], tools: ['query_nodes', 'replace_props', 'get_export_image'], localPaths: ['.local/export-raw', '.local/export'], purpose: '在指定测试副本验证并恢复字号，再导出' });
const subset = () => ({ ...scope(), nodeRefs: ['synthetic-signature'], actions: ['read'], tools: ['query_nodes'], localPaths: [] });
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, store: new ConsentStore(root) };
}
async function approve(store) {
  const pending = await store.propose(scope());
  return store.decide(pending.id, { revision: pending.revision, decision: 'approved', evidence: 'Synthetic explicit user reply: 同意上述指定范围' });
}
const recordPath = (root, id) => path.join(root, `.local/setup/consents/${id}.json`);
const boundary = result => {
  assert.equal(result.identityVerified, false);
  assert.equal(result.humanConfirmationVerified, false);
  assert.equal(result.hostApprovalConfigured, false);
  assert.match(result.instructions, /不是独立身份核验或人类确认校验/);
  assert.match(result.instructions, /不能配置或覆盖宿主审批.*OAuth/);
  assert.match(result.instructions, /已有会话明确授权.*真实依据/);
  assert.match(result.instructions, /操作列表不限制工具能力.*apply_design\/eval_script.*read.*只读/);
};

test('proposal only records pending with a concrete question; pending checks refuse execution', async t => {
  const { root, store } = await fixture(t);
  const proposed = await store.propose(scope());
  assert.match(proposed.id, /^[0-9a-f-]{36}$/);
  assert.equal(proposed.revision, 1);
  assert.equal(proposed.state, 'pending');
  assert.deepEqual(proposed.decisions, []);
  for (const item of [scope().accountRef, scope().documentRef, ...scope().nodeRefs, ...scope().tools, ...scope().localPaths, scope().purpose]) assert.ok(proposed.question.includes(item));
  assert.match(proposed.question, /读取、编辑、导出、本地写入/);
  assert.match(proposed.question, /请明确同意或拒绝/);
  assert.match(proposed.question, /目录不自动授权子路径/);
  assert.match(proposed.question, /读取内容会由 Pixso 和当前模型服务处理.*产物仅保存在上列本地路径/);
  boundary(proposed);
  const before = await fs.readFile(recordPath(root, proposed.id), 'utf8');
  const checked = await store.check(proposed.id, subset());
  assert.equal(checked.scopeCovered, false);
  assert.deepEqual(checked.reasons, ['consent_pending']);
  assert.equal('executionPolicy' in checked, false);
  assert.equal(await fs.readFile(recordPath(root, proposed.id), 'utf8'), before);
  boundary(checked);
  const another = await store.propose(scope());
  assert.notEqual(another.id, proposed.id);
});

test('approval needs explicit evidence and permits only approved exact scopes or subsets', async t => {
  const { store } = await fixture(t);
  const approved = await approve(store);
  assert.equal(approved.state, 'approved');
  assert.equal(approved.revision, 2);
  assert.match(approved.decisions[0].evidence, /explicit user reply/);
  assert.equal('question' in approved, false);
  boundary(approved);
  const requested = subset();
  const checked = await store.check(approved.id, requested);
  assert.equal(checked.scopeCovered, true);
  assert.deepEqual(checked.reasons, []);
  assert.deepEqual(checked.executionPolicy, { mcpServer: 'pixso', enabledTools: ['query_nodes'], defaultToolsApprovalMode: 'prompt', toolApprovalModes: { query_nodes: 'approve' }, localSandbox: 'read-only' });
  assert.equal((await store.check(approved.id, scope())).executionPolicy.localSandbox, 'workspace-write');
  boundary(checked);
  assert.deepEqual((await store.status(approved.id)).scope, scope());
});

test('changed account, document, nodes, actions, tools, local paths or purpose cannot expand approval', async t => {
  const { store } = await fixture(t);
  const approved = await approve(store);
  for (const [key, value, reason] of [
    ['accountRef', 'different-account', 'accountRef_changed'],
    ['documentRef', 'different-document', 'documentRef_changed'],
    ['nodeRefs', ['another-node'], 'nodeRefs_expanded'],
    ['actions', ['create'], 'actions_expanded'],
    ['tools', ['apply_design'], 'tools_expanded'],
    ['localPaths', ['.local/export/final.png'], 'localPaths_expanded'],
    ['localPaths', ['.local'], 'UNSAFE_PATH'],
    ['purpose', 'Different use', 'purpose_changed'],
  ]) {
    const requested = { ...subset(), [key]: value };
    if (reason === 'UNSAFE_PATH') { await assert.rejects(store.check(approved.id, requested), { code: reason }); continue; }
    const result = await store.check(approved.id, requested);
    assert.equal(result.scopeCovered, false, key);
    assert.deepEqual(result.reasons, [reason]);
    assert.equal('executionPolicy' in result, false);
  }
});

test('denial and revocation are terminal, preserving evidence and refusing all checks', async t => {
  const { store } = await fixture(t);
  const pending = await store.propose(scope());
  const denied = await store.decide(pending.id, { revision: 1, decision: 'denied', evidence: 'Synthetic user: 不同意' });
  assert.deepEqual((await store.check(denied.id, subset())).reasons, ['consent_denied']);
  await assert.rejects(store.decide(denied.id, { revision: 2, decision: 'approved', evidence: 'Try reopening' }), { code: 'INVALID_TRANSITION' });
  const approved = await approve(store);
  const revoked = await store.decide(approved.id, { revision: 2, decision: 'revoked', evidence: 'Synthetic user: 撤回许可' });
  assert.equal(revoked.revision, 3);
  assert.equal(revoked.decisions.length, 2);
  assert.equal(revoked.decisions[0].decision, 'approved');
  const checked = await store.check(revoked.id, scope());
  assert.equal(checked.scopeCovered, false);
  assert.deepEqual(checked.reasons, ['consent_revoked']);
  assert.equal('executionPolicy' in checked, false);
  await assert.rejects(store.decide(revoked.id, { revision: 3, decision: 'approved', evidence: 'Try reopening' }), { code: 'INVALID_TRANSITION' });
  const next = await store.propose(scope());
  await assert.rejects(store.decide(next.id, { revision: 1, decision: 'revoked', evidence: 'Invalid direct transition' }), { code: 'INVALID_TRANSITION' });
});

test('missing evidence, stale revisions and concurrent decisions cannot overwrite a user decision', async t => {
  const { root, store } = await fixture(t);
  const proposed = await store.propose(scope());
  for (const evidence of [undefined, '', '  ', 'x'.repeat(4001), 'bad\nvalue']) await assert.rejects(store.decide(proposed.id, { revision: 1, decision: 'approved', evidence }), { code: 'INVALID_DECISION' });
  const results = await Promise.allSettled(['approved', 'denied'].map(decision => store.decide(proposed.id, { revision: 1, decision, evidence: `Synthetic explicit ${decision}` })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(['BUSY', 'STALE_REVISION'].includes(results.find(result => result.status === 'rejected').reason.code));
  const before = await fs.readFile(recordPath(root, proposed.id), 'utf8');
  await assert.rejects(store.decide(proposed.id, { revision: 1, decision: 'denied', evidence: 'Stale user decision' }), { code: 'STALE_REVISION' });
  assert.equal(await fs.readFile(recordPath(root, proposed.id), 'utf8'), before);
  assert.deepEqual(await fs.readdir(path.dirname(recordPath(root, proposed.id))), [`${proposed.id}.json`]);
});

test('strict scopes reject unknown properties, unbounded/ambiguous tools and unsafe local path aliases', async t => {
  const { root, store } = await fixture(t);
  const invalid = [
    { ...scope(), token: 'synthetic-secret' }, { ...scope(), actions: ['execute'] }, { ...scope(), actions: [] },
    { ...scope(), tools: ['*'] }, { ...scope(), tools: ['mcp__pixso__query_nodes'] }, { ...scope(), tools: ['pixso.query_nodes'] },
    { ...scope(), tools: [] }, { ...scope(), nodeRefs: [] }, { ...scope(), localPaths: [] },
    { ...scope(), tools: ['query_nodes', 'query_nodes'] }, { ...scope(), accountRef: '' },
    ...['../outside', '.local/../outside', '.local/CON.png', '.local/file.', '.local\\export', '.local/secret:stream', '.local/input//x'].map(value => ({ ...scope(), localPaths: [value] })),
  ];
  for (const value of invalid) await assert.rejects(store.propose(value), error => ['INVALID_SCOPE', 'UNSAFE_PATH'].includes(error.code));
  assert.deepEqual(await fs.readdir(root), []);
});

test('missing and corrupt consent records never return coverage and are not overwritten', async t => {
  const { root, store } = await fixture(t);
  const absent = '12345678-1234-4123-8123-123456789abc';
  await assert.rejects(store.status(absent), { code: 'ENOENT' });
  await assert.rejects(store.check(absent, subset()), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(root), []);
  const approved = await approve(store);
  const valid = JSON.parse(await fs.readFile(recordPath(root, approved.id), 'utf8'));
  for (const value of ['broken', '[]', { ...valid, unexpected: true }, { ...valid, revision: 1 }, { ...valid, state: 'pending' }, { ...valid, decisions: [{ ...valid.decisions[0], evidence: '' }] }, { ...valid, scope: { ...valid.scope, tools: ['*'] } }]) {
    const bytes = typeof value === 'string' ? value : JSON.stringify(value);
    await fs.writeFile(recordPath(root, approved.id), bytes);
    await assert.rejects(store.status(approved.id), { code: 'INVALID_RECORD' });
    await assert.rejects(store.check(approved.id, subset()), { code: 'INVALID_RECORD' });
    await assert.rejects(store.decide(approved.id, { revision: 2, decision: 'revoked', evidence: 'Cannot alter damaged record' }), { code: 'INVALID_RECORD' });
    assert.equal(await fs.readFile(recordPath(root, approved.id), 'utf8'), bytes);
  }
});

test('junctions/symlinks in storage, scope paths or input are rejected without reading targets', async t => {
  for (const component of ['.local', '.local/setup', '.local/setup/consents']) {
    const { root, store } = await fixture(t);
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.mkdir(path.dirname(path.join(root, component)), { recursive: true });
    await fs.symlink(elsewhere, path.join(root, component), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.propose(scope()), { code: 'UNSAFE_PATH' });
    assert.deepEqual(await fs.readdir(elsewhere), []);
  }
  const { root, store } = await fixture(t);
  const proposed = await store.propose(scope());
  const elsewhere = path.join(root, 'elsewhere');
  await fs.mkdir(elsewhere);
  const linked = path.join(root, '.local/linked');
  await fs.symlink(elsewhere, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.propose({ ...scope(), localPaths: ['.local/linked/output'] }), { code: 'UNSAFE_PATH' });
  await assert.rejects(store.readInput('.local/linked/scope.json'));
  await fs.unlink(recordPath(root, proposed.id));
  await fs.symlink(elsewhere, recordPath(root, proposed.id), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.status(proposed.id), { code: 'UNSAFE_PATH' });
  await assert.rejects(store.decide(proposed.id, { revision: 1, decision: 'approved', evidence: 'Cannot follow record link' }), { code: 'UNSAFE_PATH' });
  const next = await store.propose(scope());
  await fs.symlink(elsewhere, path.join(root, `.local/setup/consents/${next.id}.lock`), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.decide(next.id, { revision: 1, decision: 'approved', evidence: 'Cannot follow lock link' }), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(elsewhere), []);
});

test('CLI private input, pending question, approval, policy and refusal results work end-to-end', async t => {
  const { root } = await fixture(t);
  for (const relative of ['tools/setup/consent.mjs', 'tools/setup/consent-cli.mjs', 'tools/handoff/store.mjs']) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.copyFile(path.join(repoRoot, relative), path.join(root, relative));
  }
  await fs.mkdir(path.join(root, '.local/input'), { recursive: true });
  await fs.writeFile(path.join(root, '.local/input/scope.json'), JSON.stringify(scope()));
  await fs.writeFile(path.join(root, '.local/input/subset.json'), JSON.stringify(subset()));
  const run = async (args, expectedCode = 0) => {
    let result;
    try { result = { ...await execute(process.execPath, ['tools/setup/consent-cli.mjs', ...args], { cwd: root, windowsHide: true }), code: 0 }; }
    catch (error) { result = error; }
    assert.equal(result.code, expectedCode, result.stdout);
    assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout);
    boundary(output);
    return output;
  };
  const proposed = await run(['propose', '--input', '.local/input/scope.json']);
  assert.equal(proposed.state, 'pending');
  assert.equal((await run(['check', proposed.id, '--input', '.local/input/subset.json'], 1)).scopeCovered, false);
  assert.equal((await run(['decide', proposed.id, '--revision', '1', '--decision', 'approved', '--evidence', ''], 1)).error.code, 'INVALID_DECISION');
  const approved = await run(['decide', proposed.id, '--revision', '1', '--decision', 'approved', '--evidence', 'Synthetic existing explicit user authorization']);
  assert.equal(approved.state, 'approved');
  const checked = await run(['check', proposed.id, '--input', '.local/input/subset.json']);
  assert.equal(checked.scopeCovered, true);
  assert.deepEqual(checked.executionPolicy.enabledTools, ['query_nodes']);
  assert.equal((await run(['status', proposed.id])).revision, 2);
  await run(['decide', proposed.id, '--revision', '2', '--decision', 'revoked', '--evidence', 'Synthetic user withdrawal']);
  assert.equal('executionPolicy' in await run(['check', proposed.id, '--input', '.local/input/subset.json'], 1), false);
  assert.equal((await run(['status', '../escape'], 1)).error.code, 'INVALID_ID');
  assert.equal((await run(['status', proposed.id, '--input', '.local/input/scope.json'], 1)).error.code, 'USAGE');
});

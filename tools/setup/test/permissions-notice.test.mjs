import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readSetupStatus, acknowledgePermissionsNotice, noticeVersion, maxMessageLength } from '../permissions-notice.mjs';

const execute = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = path.join(repoRoot, '.local/setup-tests');
const initialTime = new Date('2026-11-04T00:00:00Z');
const message = '已说明本人登录授权、先读指定画板，再在测试副本验证编辑和导出。';
const recordPath = root => path.join(root, '.local/setup/permissions-notice.json');
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function writeRecord(root, record) {
  await fs.mkdir(path.dirname(recordPath(root)), { recursive: true });
  await fs.writeFile(recordPath(root), typeof record === 'string' ? record : JSON.stringify(record));
}
function assertUnverified(status) {
  assert.equal(status.connectionVerified, false);
  assert.equal(status.permissionsVerified, false);
  assert.match(status.instructions, /不代表用户授权、权限验证或连接成功/);
  assert.match(status.instructions, /每个执行会话仍需检查真实工具、当前账号及目标/);
  assert.equal('ready' in status, false);
}

test('first status is read-only, requires a reminder and describes minimal access', async t => {
  const root = await fixture(t);
  const status = await readSetupStatus(root);
  assert.equal(status.needsReminder, true);
  assert.deepEqual(status.reasons, ['not_acknowledged']);
  assert.match(status.suggestedMessage, /本人登录并授权/);
  assert.match(status.suggestedMessage, /指定的画板.*测试副本验证编辑和导出/);
  assert.match(status.suggestedMessage, /项目文件权限及所需设计工具.*具体缺口.*不默认要求 bypass/);
  assertUnverified(status);
  assert.deepEqual(await fs.readdir(root), []);
});

test('acknowledgement records only the explanation and retries preserve the original record', async t => {
  const root = await fixture(t);
  const status = await acknowledgePermissionsNotice(root, { message, now: initialTime });
  assert.equal(status.needsReminder, false);
  assertUnverified(status);
  assert.deepEqual(JSON.parse(await fs.readFile(recordPath(root), 'utf8')), { schemaVersion: 1, noticeVersion, acknowledgedAt: initialTime.toISOString(), message });
  const before = await fs.readFile(recordPath(root), 'utf8');
  await acknowledgePermissionsNotice(root, { message: 'Later retry', now: new Date('2026-11-05T00:00:00Z') });
  assert.equal(await fs.readFile(recordPath(root), 'utf8'), before);
  assert.deepEqual(await fs.readdir(path.dirname(recordPath(root))), ['permissions-notice.json']);
});

test('a changed notice version requires an explanation again', async t => {
  const root = await fixture(t);
  await writeRecord(root, { schemaVersion: 1, noticeVersion: noticeVersion + 1, acknowledgedAt: initialTime.toISOString(), message });
  const status = await readSetupStatus(root);
  assert.equal(status.needsReminder, true);
  assert.deepEqual(status.reasons, ['notice_changed']);
  assertUnverified(status);
  await acknowledgePermissionsNotice(root, { message: 'Explained the current notice', now: initialTime });
  assert.equal((await readSetupStatus(root)).needsReminder, false);
});

test('invalid records cannot silently count as acknowledged or be overwritten', async t => {
  const root = await fixture(t);
  const valid = { schemaVersion: 1, noticeVersion, acknowledgedAt: initialTime.toISOString(), message };
  for (const value of ['broken', '[]', { ...valid, schemaVersion: 2 }, { ...valid, noticeVersion: 0 }, { ...valid, acknowledgedAt: null }, { ...valid, message: '' }, { ...valid, message: 'x'.repeat(maxMessageLength + 1) }, 'x'.repeat(16 * 1024 + 1)]) {
    await writeRecord(root, value);
    const before = await fs.readFile(recordPath(root), 'utf8');
    const status = await readSetupStatus(root);
    assert.equal(status.needsReminder, true);
    assert.equal(status.error.code, 'INVALID_RECORD');
    assert.match(status.error.message, /读取失败.*尚未验证/);
    assertUnverified(status);
    await assert.rejects(acknowledgePermissionsNotice(root, { message }), { code: 'INVALID_RECORD' });
    assert.equal(await fs.readFile(recordPath(root), 'utf8'), before);
    assert.deepEqual(await fs.readdir(path.dirname(recordPath(root))), ['permissions-notice.json']);
  }
});

test('invalid messages and dates fail before creating private directories', async t => {
  const root = await fixture(t);
  for (const value of [undefined, '', '  ', 5, 'x'.repeat(maxMessageLength + 1), 'bad\0message']) await assert.rejects(acknowledgePermissionsNotice(root, { message: value }), { code: 'INVALID_MESSAGE' });
  await assert.rejects(acknowledgePermissionsNotice(root, { message, now: 'invalid' }), { code: 'INVALID_TIME' });
  assert.deepEqual(await fs.readdir(root), []);
});

test('an active lock refuses a writer without changing data and concurrent retries keep one intact record', async t => {
  const root = await fixture(t);
  await acknowledgePermissionsNotice(root, { message, now: initialTime });
  const before = await fs.readFile(recordPath(root), 'utf8');
  const lock = path.join(root, '.local/setup/lock');
  await fs.writeFile(lock, 'synthetic active writer');
  await assert.rejects(acknowledgePermissionsNotice(root, { message: 'Competing writer' }), { code: 'BUSY' });
  assert.equal(await fs.readFile(lock, 'utf8'), 'synthetic active writer');
  assert.equal(await fs.readFile(recordPath(root), 'utf8'), before);
  await fs.unlink(lock);
  await fs.unlink(recordPath(root));
  const results = await Promise.allSettled(['First explanation', 'Second explanation'].map(text => acknowledgePermissionsNotice(root, { message: text, now: initialTime })));
  assert.ok(results.some(result => result.status === 'fulfilled'));
  for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'BUSY');
  const record = JSON.parse(await fs.readFile(recordPath(root), 'utf8'));
  assert.ok(['First explanation', 'Second explanation'].includes(record.message));
  assert.equal(record.noticeVersion, noticeVersion);
  assert.deepEqual(await fs.readdir(path.dirname(recordPath(root))), ['permissions-notice.json']);
});

test('symlink or junction roots, parents, records and locks are rejected without following links', async t => {
  for (const component of ['.local', '.local/setup', '.local/setup/permissions-notice.json', '.local/setup/lock']) {
    const root = await fixture(t);
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.mkdir(path.dirname(path.join(root, component)), { recursive: true });
    // A junction also tests rejection when a record path points to a directory.
    await fs.symlink(elsewhere, path.join(root, component), process.platform === 'win32' ? 'junction' : 'dir');
    if (!component.endsWith('/lock')) {
      const status = await readSetupStatus(root);
      assert.equal(status.needsReminder, true);
      assert.equal(status.error.code, 'UNSAFE_PATH');
    }
    await assert.rejects(acknowledgePermissionsNotice(root, { message }), { code: 'UNSAFE_PATH' });
    assert.deepEqual(await fs.readdir(elsewhere), []);
  }
  const root = await fixture(t);
  const real = path.join(root, 'real');
  await fs.mkdir(real);
  const linked = path.join(root, 'linked');
  await fs.symlink(real, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await readSetupStatus(linked)).error.code, 'UNSAFE_PATH');
  await assert.rejects(acknowledgePermissionsNotice(linked, { message }), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await fs.readdir(real), []);
});

test('CLI and handoff integration keep setup informational across init, status and handoff', async t => {
  const root = await fixture(t);
  for (const name of ['tools/setup/cli.mjs', 'tools/setup/permissions-notice.mjs', 'tools/handoff/cli.mjs', 'tools/handoff/store.mjs', 'tools/maintenance/dependencies.mjs']) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.copyFile(path.join(repoRoot, name), path.join(root, name));
  }
  await fs.writeFile(path.join(root, 'package.json'), '{}');
  const run = async (script, args, expectedCode = 0) => {
    let result;
    try { result = { ...await execute(process.execPath, [script, ...args], { cwd: root, windowsHide: true }), code: 0 }; }
    catch (error) { result = error; }
    assert.equal(result.code, expectedCode, result.stdout);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  const first = await run('tools/setup/cli.mjs', ['status']);
  assert.equal(first.needsReminder, true);
  await assert.rejects(fs.stat(path.join(root, '.local')), { code: 'ENOENT' });
  await fs.mkdir(path.join(root, '.local/input'), { recursive: true });
  await fs.writeFile(path.join(root, '.local/input/brief.json'), JSON.stringify({ brief: 'Synthetic permissions integration', constraints: [] }));
  const initial = await run('tools/handoff/cli.mjs', ['init', 'synthetic', '--input', '.local/input/brief.json']);
  assert.equal(initial.ok, true);
  assert.equal(initial.setup.needsReminder, true);
  assert.equal(initial.revision, 1);
  await run('tools/setup/cli.mjs', ['acknowledge', '--message', message]);
  for (const command of ['status', 'handoff']) {
    const result = await run('tools/handoff/cli.mjs', [command, 'synthetic']);
    assert.equal(result.setup.needsReminder, false);
    assertUnverified(result.setup);
    assert.equal(result.revision, 1);
    assert.equal(result.phase, 'planning');
    assert.equal(result.history.length, 1);
  }
  await fs.writeFile(recordPath(root), 'broken');
  const broken = await run('tools/handoff/cli.mjs', ['handoff', 'synthetic']);
  assert.equal(broken.ok, true);
  assert.equal(broken.setup.needsReminder, true);
  assert.equal(broken.setup.error.code, 'INVALID_RECORD');
  assert.equal(broken.revision, 1);
  assertUnverified(broken.setup);
  assert.equal((await run('tools/setup/cli.mjs', ['status'], 1)).error.code, 'INVALID_RECORD');
  assert.equal((await run('tools/setup/cli.mjs', ['acknowledge', '--message', ''], 1)).error.code, 'INVALID_MESSAGE');
  assert.equal((await run('tools/setup/cli.mjs', ['status', '--message', 'unexpected'], 1)).error.code, 'USAGE');
});

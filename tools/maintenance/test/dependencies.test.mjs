import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDependencies, readMaintenanceStatus } from '../dependencies.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const base = path.join(repoRoot, '.local', 'maintenance-tests');
const initialTime = new Date('2026-11-01T00:00:00Z');
const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
const clean = async args => ({ code: 0, stdout: JSON.stringify(args[0] === 'outdated' ? {} : { metadata: { vulnerabilities: counts } }) });

async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  await fs.mkdir(path.join(root, 'tools/png-under-200k'), { recursive: true });
  await Promise.all(['package.json', 'package-lock.json', 'tools/png-under-200k/package.json', 'tools/png-under-200k/package-lock.json'].map(name => fs.writeFile(path.join(root, name), '{}\n')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('first status is offline, due and does not create maintenance files', async t => {
  const root = await fixture(t);
  const status = await readMaintenanceStatus(root, initialTime);
  assert.deepEqual(status.reasons, ['no_successful_check']);
  assert.equal(status.actionRequired, true);
  await assert.rejects(fs.stat(path.join(root, '.local')), { code: 'ENOENT' });
});

test('recent successful check is quiet; seven days and custom intervals become due', async t => {
  const root = await fixture(t);
  const checked = await checkDependencies(root, { runner: clean, now: initialTime });
  assert.equal(checked.ok, true);
  assert.equal(checked.due, false);
  assert.equal(checked.actionRequired, false);
  assert.equal((await readMaintenanceStatus(root, new Date('2026-11-07T23:59:59Z'))).due, false);
  assert.deepEqual((await readMaintenanceStatus(root, new Date('2026-11-08T00:00:00Z'))).reasons, ['expired']);
  assert.equal((await readMaintenanceStatus(root, new Date('2026-11-08T00:00:00Z'), { days: 14 })).due, false);
});

test('manifest, lock changes, and missing locks change the fingerprint', async t => {
  const root = await fixture(t);
  await checkDependencies(root, { runner: clean, now: initialTime });
  await fs.writeFile(path.join(root, 'tools/png-under-200k/package.json'), '{"changed":true}');
  assert.deepEqual((await readMaintenanceStatus(root, initialTime)).reasons, ['dependencies_changed']);
  await checkDependencies(root, { runner: clean, now: initialTime });
  await fs.unlink(path.join(root, 'package-lock.json'));
  assert.deepEqual((await readMaintenanceStatus(root, initialTime)).reasons, ['dependencies_changed']);
});

test('npm exit 1 with valid updates and audit counts is a successful check needing action', async t => {
  const root = await fixture(t);
  const calls = [];
  const runner = async (args, options) => {
    calls.push({ args, options });
    return { code: 1, stdout: JSON.stringify(args[0] === 'outdated'
      ? { react: { current: '19.1.0', wanted: '19.2.0', latest: '19.2.0' }, vite: { current: '7.0.0', wanted: '7.0.0', latest: '8.0.0' } }
      : { metadata: { vulnerabilities: { ...counts, high: 1, total: 1 } } }) };
  };
  const result = await checkDependencies(root, { runner, now: initialTime });
  assert.equal(result.ok, true);
  assert.equal(result.due, false);
  assert.equal(result.actionRequired, true);
  assert.equal(result.updates.total, 2);
  assert.equal(result.updates.compatible, 1);
  assert.equal(result.updates.latestOnly, 1);
  assert.equal(result.vulnerabilities.high, 1);
  assert.deepEqual(calls.map(call => call.args), [
    ['outdated', '--json', '--prefix', 'tools/png-under-200k'],
    ['audit', '--json', '--prefix', 'tools/png-under-200k'],
  ]);
  assert.equal(calls[0].options.cwd, root);
  assert.equal(calls[0].options.timeout, 60_000);
});

test('network failure preserves the previous successful timestamp and makes check due', async t => {
  const root = await fixture(t);
  await checkDependencies(root, { runner: clean, now: initialTime });
  const result = await checkDependencies(root, {
    runner: async () => ({ code: 1, stdout: JSON.stringify({ error: { code: 'ENETUNREACH' } }) }),
    now: new Date('2026-11-02T00:00:00Z'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.checkedAt, initialTime.toISOString());
  assert.deepEqual(result.reasons, ['last_check_failed']);
  const recovered = await checkDependencies(root, { runner: clean, now: new Date('2026-11-03T00:00:00Z') });
  assert.equal(recovered.lastCheckError, null);
  assert.equal(recovered.due, false);
});

test('missing installed dependencies are valid outdated output and recommend installation', async t => {
  const root = await fixture(t);
  const runner = async args => args[0] === 'outdated'
    ? { code: 1, stdout: JSON.stringify({ react: { wanted: '19.2.0', latest: '19.2.0' } }) }
    : clean(args);
  const result = await checkDependencies(root, { runner, now: initialTime });
  assert.equal(result.ok, true);
  assert.equal(result.actionRequired, true);
  assert.equal(result.updates.missing, 1);
  assert.equal(result.updates.compatible, 0);
  assert.equal(result.updates.latestOnly, 0);
  assert.equal(result.updates.packages[0].current, null);
  assert.match(result.instructions, /先在仓库根目录运行 npm ci/);
});

test('parse, malformed schema, executable, and unexpected npm exit failures never stamp success', async t => {
  for (const runner of [
    async () => ({ code: 0, stdout: 'not json' }),
    async () => ({ code: 0, stdout: '[]' }),
    async () => ({ code: 0, stdout: '{"bad":{"current":"1"}}' }),
    async args => args[0] === 'outdated' ? { code: 0, stdout: '{}' } : { code: 0, stdout: '{"metadata":{}}' },
    async () => ({ code: 2, stdout: '{}' }),
    async () => { throw Object.assign(new Error('timeout'), { code: 'NPM_EXECUTION_FAILED' }); },
  ]) {
    const root = await fixture(t);
    const result = await checkDependencies(root, { runner, now: initialTime });
    assert.equal(result.ok, false);
    assert.equal(result.checkedAt, null);
    assert.equal(result.due, true);
  }
});

test('changing dependencies during a check cannot create a stale success', async t => {
  const root = await fixture(t);
  const runner = async args => {
    if (args[0] === 'audit') await fs.writeFile(path.join(root, 'package-lock.json'), '{"changed":true}');
    return clean(args);
  };
  const result = await checkDependencies(root, { runner, now: initialTime });
  assert.equal(result.ok, false);
  assert.equal(result.lastCheckError.code, 'DEPENDENCIES_CHANGED');
  assert.equal(result.checkedAt, null);
});

test('concurrent checks fail busy without overwriting the active result; lock is released', async t => {
  const root = await fixture(t);
  let competing = false;
  const runner = async args => {
    if (!competing) {
      competing = true;
      await assert.rejects(checkDependencies(root, { runner: clean, now: initialTime }), { code: 'BUSY' });
    }
    return clean(args);
  };
  assert.equal((await checkDependencies(root, { runner, now: initialTime })).ok, true);
  assert.equal((await checkDependencies(root, { runner: clean, now: initialTime })).ok, true);
  const files = await fs.readdir(path.join(root, '.local/maintenance'));
  assert.deepEqual(files, ['dependencies.json']);
});

test('symlink or junction maintenance parents are rejected before running npm', async t => {
  for (const component of ['.local', '.local/maintenance']) {
    const root = await fixture(t);
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere);
    if (component !== '.local') await fs.mkdir(path.join(root, '.local'));
    await fs.symlink(elsewhere, path.join(root, component), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(checkDependencies(root, { runner: () => assert.fail('npm must not run') }), { code: 'UNSAFE_PATH' });
    assert.deepEqual(await fs.readdir(elsewhere), []);
  }
});

test('invalid intervals and corrupt reports fail explicitly instead of losing records', async t => {
  const root = await fixture(t);
  for (const days of [0, -1, 1.5, NaN]) await assert.rejects(readMaintenanceStatus(root, initialTime, { days }), { code: 'INVALID_DAYS' });
  await fs.mkdir(path.join(root, '.local/maintenance'), { recursive: true });
  const report = path.join(root, '.local/maintenance/dependencies.json');
  await fs.writeFile(report, 'broken');
  await assert.rejects(checkDependencies(root, { runner: clean, now: initialTime }), { code: 'INVALID_REPORT' });
  assert.equal(await fs.readFile(report, 'utf8'), 'broken');
});

import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const reportName = 'dependencies.json';
const manifests = ['package.json', 'package-lock.json', 'tools/png-under-200k/package.json', 'tools/png-under-200k/package-lock.json'];
const dayMs = 86_400_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const instructions = '在不打断当前制作任务的空档检查依赖；依赖未安装时先在仓库根目录运行 npm ci；有兼容更新时由模型运行 npm update --prefix tools/png-under-200k，然后从仓库根目录运行 npm test、npm run build，再重新检查。不得自动使用 --force 或跨主版本升级。仅在失败或需要用户决定时汇报。';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const dateOf = value => {
  const date = new Date(typeof value === 'function' ? value() : value);
  if (!Number.isFinite(date.getTime())) fail('INVALID_TIME', 'Invalid check time');
  return date;
};
function validateDays(days) {
  if (!Number.isSafeInteger(days) || days < 1) fail('INVALID_DAYS', '--days must be a positive integer');
}

// Check each fixed path component before reading/writing; junctions are symlinks on Windows.
async function privatePath(root, name, create = false) {
  const parts = ['.local', 'maintenance', ...(name ? [name] : [])];
  let target = path.resolve(root);
  const rootInfo = await fs.lstat(target);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('UNSAFE_PATH', 'Repository root must be a real directory');
  for (let index = 0; index < parts.length; index++) {
    target = path.join(target, parts[index]);
    let info;
    try { info = await fs.lstat(target); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (create && index < 2) {
        await fs.mkdir(target).catch(error => { if (error.code !== 'EEXIST') throw error; });
        info = await fs.lstat(target);
      }
    }
    if (info?.isSymbolicLink()) fail('UNSAFE_PATH', 'Maintenance paths cannot contain symlinks or junctions');
    if (info && index < 2 && !info.isDirectory()) fail('UNSAFE_PATH', 'Maintenance parent must be a directory');
    if (info && index >= 2 && !info.isFile()) fail('UNSAFE_PATH', 'Maintenance record must be a regular file');
  }
  return target;
}

async function fingerprint(root) {
  const hash = createHash('sha256');
  for (const name of manifests) {
    hash.update(name).update('\0');
    try { hash.update(await fs.readFile(path.join(root, name))); }
    catch (error) {
      if (error.code !== 'ENOENT' || !name.endsWith('package-lock.json')) throw error;
      hash.update('<missing>');
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function readReport(root) {
  const target = await privatePath(root, reportName);
  let handle;
  try {
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) fail('INVALID_REPORT', 'Invalid maintenance record');
    const report = JSON.parse(await handle.readFile('utf8'));
    if (!object(report) || report.schemaVersion !== 1) fail('INVALID_REPORT', 'Invalid maintenance record');
    if (report.checkedAt && (!Number.isFinite(Date.parse(report.checkedAt)) || !/^[a-f0-9]{64}$/.test(report.fingerprint))) fail('INVALID_REPORT', 'Invalid successful check record');
    return report;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) fail('INVALID_REPORT', 'Maintenance record is not valid JSON');
    throw error;
  } finally { await handle?.close(); }
}

export async function readMaintenanceStatus(root, now = new Date(), { days = 7 } = {}) {
  validateDays(days);
  const date = dateOf(now);
  const [report, currentFingerprint] = await Promise.all([readReport(root), fingerprint(root)]);
  const reasons = [];
  if (!report?.checkedAt) reasons.push('no_successful_check');
  else {
    if (date.getTime() - Date.parse(report.checkedAt) >= days * dayMs) reasons.push('expired');
    if (report.fingerprint !== currentFingerprint) reasons.push('dependencies_changed');
    if (Date.parse(report.checkedAt) > date.getTime()) reasons.push('clock_changed');
  }
  const lastCheckError = report?.lastAttempt?.error ?? null;
  if (lastCheckError) reasons.push('last_check_failed');
  const updates = report?.updates ?? null;
  const vulnerabilities = report?.vulnerabilities ?? null;
  return {
    due: reasons.length > 0, reasons, days,
    checkedAt: report?.checkedAt ?? null,
    fingerprint: currentFingerprint,
    checkedFingerprint: report?.fingerprint ?? null,
    updates, vulnerabilities, lastCheckError,
    actionRequired: reasons.length > 0 || Boolean(updates?.total || vulnerabilities?.total),
    instructions,
  };
}

async function npmCommand() {
  // Invoke the JS entry directly on Windows: execFile cannot execute npm.cmd without a shell.
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  if (process.platform === 'win32') {
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
    }
  }
  for (const candidate of candidates) {
    if (!candidate || path.basename(candidate) !== 'npm-cli.js') continue;
    try { await fs.access(candidate); return { file: process.execPath, prefix: [candidate] }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (process.platform !== 'win32') return { file: 'npm', prefix: [] };
  fail('NPM_NOT_FOUND', 'Cannot locate npm-cli.js; install Node.js with npm');
}

export async function runNpm(args, { cwd, timeout = 60_000 } = {}) {
  const { file, prefix } = await npmCommand();
  try {
    const result = await execute(file, [...prefix, ...args], { cwd, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false });
    return { code: 0, stdout: result.stdout };
  } catch (error) {
    if (error.killed || error.signal || typeof error.code !== 'number') fail('NPM_EXECUTION_FAILED', 'npm could not complete (network, timeout, or executable failure)');
    return { code: error.code, stdout: error.stdout ?? '' };
  }
}

function parseResult(result, operation) {
  if (!result || ![0, 1].includes(result.code)) fail('NPM_CHECK_FAILED', `npm ${operation} failed`);
  let data;
  try { data = JSON.parse(result.stdout); }
  catch { fail('INVALID_NPM_JSON', `npm ${operation} did not return valid JSON`); }
  if (!object(data) || data.error) fail('NPM_CHECK_FAILED', `npm ${operation} returned an error`);
  return data;
}

function summarizeOutdated(result) {
  const data = parseResult(result, 'outdated');
  const packages = Object.entries(data).map(([name, item]) => {
    if (!object(item) || !['wanted', 'latest'].every(key => typeof item[key] === 'string') || (item.current !== undefined && typeof item.current !== 'string')) fail('INVALID_NPM_JSON', 'npm outdated returned an invalid package');
    return { name, current: item.current ?? null, wanted: item.wanted, latest: item.latest };
  });
  return {
    total: packages.length,
    missing: packages.filter(item => item.current === null).length,
    compatible: packages.filter(item => item.current !== null && item.current !== item.wanted).length,
    latestOnly: packages.filter(item => item.current === item.wanted && item.current !== item.latest).length,
    packages,
  };
}

function summarizeAudit(result) {
  const data = parseResult(result, 'audit');
  const counts = data.metadata?.vulnerabilities;
  const keys = ['info', 'low', 'moderate', 'high', 'critical', 'total'];
  if (!object(counts) || !keys.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)) fail('INVALID_NPM_JSON', 'npm audit returned invalid vulnerability counts');
  return Object.fromEntries(keys.map(key => [key, counts[key]]));
}

async function writeReport(root, report) {
  const target = await privatePath(root, reportName, true);
  const temp = await privatePath(root, `tmp-${randomUUID()}.json`, true);
  try {
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(JSON.stringify(report, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await privatePath(root, reportName);
    await fs.rename(temp, target);
  } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function checkDependencies(root, { runner = runNpm, now = () => new Date(), days = 7 } = {}) {
  validateDays(days);
  root = path.resolve(root);
  const lockPath = await privatePath(root, 'lock', true);
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') fail('BUSY', 'Another dependency check holds the maintenance lock; retry when it finishes. Remove a leftover lock only after confirming its process stopped.');
    throw error;
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: dateOf(now).toISOString() }));
    const previous = await readReport(root);
    try {
      const before = await fingerprint(root);
      const options = { cwd: root, timeout: 60_000 };
      const outdated = await runner(['outdated', '--json', '--prefix', 'tools/png-under-200k'], options);
      const updates = summarizeOutdated(outdated);
      const audit = await runner(['audit', '--json', '--prefix', 'tools/png-under-200k'], options);
      const vulnerabilities = summarizeAudit(audit);
      if (before !== await fingerprint(root)) fail('DEPENDENCIES_CHANGED', 'Dependencies changed during the check; retry after installation finishes');
      const checkedAt = dateOf(now).toISOString();
      await writeReport(root, { schemaVersion: 1, checkedAt, fingerprint: before, updates, vulnerabilities, lastAttempt: { at: checkedAt, error: null } });
      return { ok: true, ...await readMaintenanceStatus(root, now, { days }) };
    } catch (error) {
      const attempt = { at: dateOf(now).toISOString(), error: { code: error.code ?? 'CHECK_FAILED', message: error.message } };
      await writeReport(root, { ...previous, schemaVersion: 1, lastAttempt: attempt });
      return { ok: false, ...await readMaintenanceStatus(root, now, { days }) };
    }
  } finally { await lock.close(); await fs.unlink(lockPath); }
}

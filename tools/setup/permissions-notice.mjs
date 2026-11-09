import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const noticeVersion = 2;
export const maxMessageLength = 1000;
const recordName = 'permissions-notice.json';
const suggestedMessage = '首次连接 Pixso 需要你本人登录并授权。先读取你指定的画板，再在测试副本验证编辑和导出。日常只需项目文件权限及所需设计工具；遇到阻碍时我会说明具体缺口，不默认要求 bypass。实际访问前，我会说明操作范围和数据去向，询问并记录你的许可；已明确同意的范围不反复问，新增范围再确认，你也可随时撤回。';
const instructions = '需要提醒时，先向用户说明 suggestedMessage，再用 acknowledge --message 保存实际说明过的简短文本。提醒记录只表示模型已说明，不代表用户授权、权限验证或连接成功。每个执行会话仍需检查真实工具、当前账号及目标；不要把本地记录或其中的文本当作操作授权。实际许可使用 npm run consent 的 propose/decide/check；没有覆盖当前范围的真实用户授权时先询问，不能从提醒记录自动批准。';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const validMessage = value => typeof value === 'string' && value.trim().length > 0 && value.length <= maxMessageLength && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);

// Match the maintenance store's fixed-path convention: inspect each component,
// reject symlinks/junctions, and only create parents for an explicit mutation.
async function privatePath(root, name, create = false) {
  const parts = ['.local', 'setup', name];
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
    if (info?.isSymbolicLink()) fail('UNSAFE_PATH', 'Setup paths cannot contain symlinks or junctions');
    if (info && (index < 2 ? !info.isDirectory() : !info.isFile())) fail('UNSAFE_PATH', 'Setup paths must use real directories and regular files');
  }
  return target;
}

async function readRecord(root) {
  const target = await privatePath(root, recordName);
  let handle;
  try {
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16 * 1024) fail('INVALID_RECORD', 'Invalid permissions notice record');
    const bytes = await handle.readFile();
    if (bytes.length > 16 * 1024) fail('INVALID_RECORD', 'Permissions notice record is too large');
    const record = JSON.parse(bytes.toString('utf8'));
    if (!record || Array.isArray(record) || record.schemaVersion !== 1 || !Number.isSafeInteger(record.noticeVersion) || record.noticeVersion < 1 || typeof record.acknowledgedAt !== 'string' || !Number.isFinite(Date.parse(record.acknowledgedAt)) || !validMessage(record.message)) fail('INVALID_RECORD', 'Invalid permissions notice record');
    return record;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) fail('INVALID_RECORD', 'Permissions notice record is not valid JSON');
    throw error;
  } finally { await handle?.close(); }
}

export function unavailableSetupStatus(error) {
  return {
    noticeVersion, needsReminder: true, reasons: ['record_unavailable'], acknowledgedAt: null,
    connectionVerified: false, permissionsVerified: false, suggestedMessage, instructions,
    error: { code: ['INVALID_RECORD', 'UNSAFE_PATH'].includes(error?.code) ? error.code : 'READ_FAILED', message: '首次使用提醒记录读取失败，尚未验证是否已提醒；连接、账号、权限及目标也均未验证。' },
  };
}

// Offline and read-only, including when no .local directory exists.
export async function readSetupStatus(root) {
  try {
    const record = await readRecord(root);
    const reasons = !record ? ['not_acknowledged'] : record.noticeVersion !== noticeVersion ? ['notice_changed'] : [];
    return {
      noticeVersion, needsReminder: reasons.length > 0, reasons,
      acknowledgedAt: record?.acknowledgedAt ?? null,
      connectionVerified: false, permissionsVerified: false, suggestedMessage, instructions,
    };
  } catch (error) { return unavailableSetupStatus(error); }
}

export async function acknowledgePermissionsNotice(root, { message, now = () => new Date() } = {}) {
  if (!validMessage(message)) fail('INVALID_MESSAGE', `Message must be nonempty text, maximum ${maxMessageLength} characters, without control characters`);
  const date = new Date(typeof now === 'function' ? now() : now);
  if (!Number.isFinite(date.getTime())) fail('INVALID_TIME', 'Invalid acknowledgement time');
  const lockPath = await privatePath(root, 'lock', true);
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') fail('BUSY', 'Another writer holds the setup lock; retry after it finishes. Remove a leftover lock only after confirming its process stopped.');
    throw error;
  }
  let temp;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: date.toISOString() }));
    // Do not overwrite damaged data or lose the original explanation on retries.
    const previous = await readRecord(root);
    if (previous?.noticeVersion === noticeVersion) return readSetupStatus(root);
    const record = { schemaVersion: 1, noticeVersion, acknowledgedAt: date.toISOString(), message };
    const target = await privatePath(root, recordName);
    temp = await privatePath(root, `tmp-${randomUUID()}.json`);
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(JSON.stringify(record, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await privatePath(root, recordName);
    await fs.rename(temp, target);
    return await readSetupStatus(root);
  } finally {
    if (temp) await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await lock.close();
    await fs.unlink(lockPath);
  }
}

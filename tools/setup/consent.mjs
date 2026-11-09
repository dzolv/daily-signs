import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HandoffStore } from '../handoff/store.mjs';

export class ConsentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new ConsentError(code, message); };
const requireThat = (condition, code = 'INVALID_SCOPE', message = 'Invalid consent scope') => { if (!condition) fail(code, message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max = 500) => typeof value === 'string' && value === value.trim() && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const listKeys = ['nodeRefs', 'actions', 'tools', 'localPaths'];
const actions = ['read', 'edit', 'create', 'export', 'local-write'];
const isoDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const idOf = value => { requireThat(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value), 'INVALID_ID', 'Consent ID must be a generated UUID'); return value; };
const instructions = '这只是模型保存的用户许可记录，不是独立身份核验或人类确认校验；不能配置或覆盖宿主审批、组织策略和 OAuth 授权。必须向用户实际询问并等待明确回复；已有会话明确授权时可记录真实依据，不必重复询问。范围变化须重新申请；拒绝或撤回后不得执行。单次 executionPolicy 仅为已记录许可对应的配置建议，不修改全局、不启动 CLI；实际工具、账号、目标与宿主审批仍须逐会话核对。操作列表不限制工具能力；模型必须核对工具真实能力，特别是 apply_design/eval_script 不能因 read 操作就视作只读。不要存储凭据。';
export const consentBoundary = Object.freeze({ identityVerified: false, humanConfirmationVerified: false, hostApprovalConfigured: false, instructions });

function privateParts(relative) {
  requireThat(text(relative, 1000) && !path.isAbsolute(relative) && !/[\\:]/.test(relative), 'UNSAFE_PATH', 'Use a .local/ path with forward slashes');
  const parts = relative.split('/');
  requireThat(parts[0] === '.local' && parts.length > 1 && parts.every(part => part && part !== '.' && part !== '..' && !/[ .]$/.test(part) && !/[<>"|?*]/.test(part) && !/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\..*)?$/i.test(part)), 'UNSAFE_PATH', 'Private paths cannot contain aliases, devices or traversal');
  return parts;
}

// Same fixed private-store convention as setup/maintenance: no link components,
// exclusive locks, synced temporary files and atomic replacement. Missing paths
// are inspected without creating anything unless explicitly writing a record.
async function safePath(root, relative, { createParents = false, regularFile = false } = {}) {
  const parts = privateParts(relative);
  let target = path.resolve(root);
  const rootInfo = await fs.lstat(target);
  requireThat(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'UNSAFE_PATH', 'Repository root must be a real directory');
  for (let index = 0; index < parts.length; index++) {
    target = path.join(target, parts[index]);
    let info;
    try { info = await fs.lstat(target); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (createParents && index < parts.length - 1) {
        await fs.mkdir(target).catch(error => { if (error.code !== 'EEXIST') throw error; });
        info = await fs.lstat(target);
      }
    }
    if (info) {
      requireThat(!info.isSymbolicLink(), 'UNSAFE_PATH', 'Private paths cannot contain symlinks or junctions');
      requireThat(index < parts.length - 1 ? info.isDirectory() : regularFile ? info.isFile() : info.isDirectory() || info.isFile(), 'UNSAFE_PATH', 'Private paths require real directories and regular files');
    }
  }
  return target;
}

function validateScope(scope) {
  requireThat(exact(scope, ['accountRef', 'documentRef', ...listKeys, 'purpose']));
  requireThat(text(scope.accountRef) && text(scope.documentRef) && text(scope.purpose, 1000));
  for (const key of listKeys) requireThat(Array.isArray(scope[key]) && scope[key].length <= 100 && scope[key].every(value => text(value, key === 'localPaths' ? 1000 : 500)) && new Set(scope[key]).size === scope[key].length);
  requireThat(scope.actions.length > 0 && scope.actions.every(value => actions.includes(value)));
  requireThat(scope.tools.every(value => /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value) && !value.startsWith('mcp__')));
  requireThat(!scope.actions.some(value => value !== 'local-write') || (scope.nodeRefs.length > 0 && scope.tools.length > 0));
  requireThat(!scope.actions.includes('local-write') || scope.localPaths.length > 0);
  scope.localPaths.forEach(privateParts);
  return structuredClone(scope);
}

function questionFor(scope) {
  const labels = { read: '读取', edit: '编辑', create: '创建', export: '导出', 'local-write': '本地写入' };
  return `为“${scope.purpose}”，是否允许我使用账号标签“${scope.accountRef}”，操作文件“${scope.documentRef}”的以下节点：${scope.nodeRefs.join('、') || '无远程节点'}；操作：${scope.actions.map(value => labels[value]).join('、')}；工具：${scope.tools.join('、') || '无远程工具'}；本地路径：${scope.localPaths.join('、') || '无'}？读取内容会由 Pixso 和当前模型服务处理，产物仅保存在上列本地路径（未列出则不新增本地产物）。范围仅限所列成员，本地目录不自动授权子路径。请明确同意或拒绝；不需要提供密码或令牌。`;
}

function validateRecord(record, id) {
  requireThat(exact(record, ['schemaVersion', 'id', 'revision', 'state', 'scope', 'createdAt', 'updatedAt', 'decisions']), 'INVALID_RECORD', 'Invalid consent record');
  requireThat(record.schemaVersion === 1 && record.id === id && Number.isSafeInteger(record.revision) && isoDate(record.createdAt) && isoDate(record.updatedAt) && Array.isArray(record.decisions) && record.decisions.length <= 2 && record.revision === record.decisions.length + 1, 'INVALID_RECORD', 'Invalid consent record');
  try { validateScope(record.scope); }
  catch { fail('INVALID_RECORD', 'Invalid stored consent scope'); }
  let state = 'pending';
  for (const entry of record.decisions) {
    requireThat(exact(entry, ['decision', 'evidence', 'at']) && text(entry.evidence, 4000) && isoDate(entry.at) && ((state === 'pending' && ['approved', 'denied'].includes(entry.decision)) || (state === 'approved' && entry.decision === 'revoked')), 'INVALID_RECORD', 'Invalid consent decision history');
    state = entry.decision;
  }
  requireThat(record.state === state && record.updatedAt === (record.decisions.at(-1)?.at ?? record.createdAt), 'INVALID_RECORD', 'Invalid consent state');
  return record;
}

export class ConsentStore {
  constructor(root) { this.root = path.resolve(root); }
  async readInput(relative) { return new HandoffStore(this.root).readInput(relative); }
  recordPath(id) { return `.local/setup/consents/${idOf(id)}.json`; }
  async readRecord(id) {
    const target = await safePath(this.root, this.recordPath(id), { regularFile: true });
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat();
      requireThat(info.isFile() && info.size <= 512 * 1024, 'INVALID_RECORD', 'Consent record must be a regular file under 512 KiB');
      const bytes = await handle.readFile();
      requireThat(bytes.length <= 512 * 1024, 'INVALID_RECORD', 'Consent record exceeds 512 KiB');
      let data;
      try { data = JSON.parse(bytes.toString('utf8')); }
      catch { fail('INVALID_RECORD', 'Consent record is not valid JSON'); }
      return validateRecord(data, id);
    } finally { await handle.close(); }
  }
  result(record) { return { ...record, ...(record.state === 'pending' ? { question: questionFor(record.scope) } : {}), ...consentBoundary }; }
  async write(id, action) {
    const lockPath = await safePath(this.root, `.local/setup/consents/${idOf(id)}.lock`, { createParents: true, regularFile: true });
    let lock;
    try { lock = await fs.open(lockPath, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') fail('BUSY', 'Another writer holds this consent lock; retry after it finishes'); throw error; }
    let temp;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      const record = validateRecord(await action(), id);
      const target = await safePath(this.root, this.recordPath(id), { regularFile: true });
      temp = await safePath(this.root, `.local/setup/consents/tmp-${randomUUID()}.json`, { regularFile: true });
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(JSON.stringify(record, null, 2) + '\n'); await handle.sync(); }
      finally { await handle.close(); }
      await safePath(this.root, this.recordPath(id), { regularFile: true });
      await fs.rename(temp, target);
      return this.result(record);
    } finally {
      try { if (temp) await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      finally { await lock.close(); await fs.unlink(lockPath); }
    }
  }
  async propose(input) {
    const scope = validateScope(input);
    for (const relative of scope.localPaths) await safePath(this.root, relative);
    const id = randomUUID();
    return this.write(id, async () => {
      const target = await safePath(this.root, this.recordPath(id), { regularFile: true });
      try { await fs.lstat(target); fail('ALREADY_EXISTS', 'Consent ID already exists'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const at = new Date().toISOString();
      return { schemaVersion: 1, id, revision: 1, state: 'pending', scope, createdAt: at, updatedAt: at, decisions: [] };
    });
  }
  async decide(id, { revision, decision, evidence } = {}) {
    idOf(id);
    requireThat(Number.isSafeInteger(revision) && revision > 0 && ['approved', 'denied', 'revoked'].includes(decision) && text(evidence, 4000), 'INVALID_DECISION', 'Decision requires a positive revision and nonempty evidence of the actual user response');
    return this.write(id, async () => {
      const record = await this.readRecord(id);
      requireThat(record.revision === revision, 'STALE_REVISION', 'Consent revision changed; read status before deciding');
      requireThat((record.state === 'pending' && ['approved', 'denied'].includes(decision)) || (record.state === 'approved' && decision === 'revoked'), 'INVALID_TRANSITION', 'Only pending approval/denial and approved revocation are permitted');
      const at = new Date().toISOString();
      return { ...record, revision: revision + 1, state: decision, updatedAt: at, decisions: [...record.decisions, { decision, evidence, at }] };
    });
  }
  async status(id) { return this.result(await this.readRecord(id)); }
  async check(id, input) {
    const requested = validateScope(input);
    for (const relative of requested.localPaths) await safePath(this.root, relative);
    const record = await this.readRecord(id);
    const reasons = [];
    if (record.state !== 'approved') reasons.push(`consent_${record.state}`);
    for (const key of ['accountRef', 'documentRef']) if (requested[key] !== record.scope[key]) reasons.push(`${key}_changed`);
    for (const key of listKeys) if (requested[key].some(value => !record.scope[key].includes(value))) reasons.push(`${key}_expanded`);
    // Purpose is not an additional access selector, but cannot be repurposed silently.
    if (requested.purpose !== record.scope.purpose) reasons.push('purpose_changed');
    const scopeCovered = reasons.length === 0;
    return {
      id: record.id, revision: record.revision, state: record.state, scopeCovered, reasons, ...consentBoundary,
      ...(scopeCovered ? { executionPolicy: {
        mcpServer: 'pixso', enabledTools: requested.tools, defaultToolsApprovalMode: 'prompt',
        toolApprovalModes: Object.fromEntries(requested.tools.map(tool => [tool, 'approve'])),
        localSandbox: requested.actions.includes('local-write') ? 'workspace-write' : 'read-only',
      } } : {}),
    };
  }
}

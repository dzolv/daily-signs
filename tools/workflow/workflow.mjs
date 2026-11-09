import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { HandoffStore } from '../handoff/store.mjs';
import { ConsentStore } from '../setup/consent.mjs';
import { readSetupStatus } from '../setup/permissions-notice.mjs';
import { readMaintenanceStatus } from '../maintenance/dependencies.mjs';

const requireTool = createRequire(new URL('../png-under-200k/package.json', import.meta.url));
const MAX_PNG = 100 * 1024 * 1024;
export const MAX_EXPORT_INPUT = 140 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const check = (condition, code, message) => { if (!condition) fail(code, message); };
export const canonical = value => JSON.stringify(value, (_, entry) => object(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function preflight(root, { consent, scope, localOnly = false } = {}) {
  const results = await Promise.allSettled([readSetupStatus(root), readMaintenanceStatus(root)]);
  const issues = [];
  const [setup, maintenance] = results.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    issues.push({ code: index ? 'MAINTENANCE_UNAVAILABLE' : 'SETUP_UNAVAILABLE', blocking: true });
    return null;
  });
  if (setup?.error) issues.push({ code: setup.error.code, blocking: true });
  if (setup?.needsReminder) issues.push({ code: 'SETUP_EXPLANATION_DUE', blocking: false });
  if (maintenance?.actionRequired) issues.push({ code: 'DEPENDENCY_MAINTENANCE_DUE', blocking: false });
  try { requireTool('sharp'); requireTool('upng-js'); }
  catch { issues.push({ code: 'DEPENDENCIES_NOT_INSTALLED', blocking: true }); }
  let checkedConsent = null;
  if (!localOnly) {
    if (!consent || !scope) issues.push({ code: 'CONSENT_SCOPE_REQUIRED', blocking: true });
    else {
      try {
        const store = new ConsentStore(root);
        checkedConsent = await store.check(consent, await store.readInput(scope));
        if (!checkedConsent.scopeCovered) issues.push({ code: 'CONSENT_NOT_COVERED', reasons: checkedConsent.reasons, blocking: true });
      } catch (error) { issues.push({ code: error.code ?? 'CONSENT_CHECK_FAILED', blocking: true }); }
    }
  }
  const ready = !issues.some(issue => issue.blocking);
  return {
    ready, remoteReady: localOnly ? null : ready && checkedConsent?.scopeCovered === true,
    needsHumanAction: !localOnly && checkedConsent?.scopeCovered !== true,
    hostAccessVerified: false, issues,
    setup: setup && { needsReminder: setup.needsReminder, reasons: setup.reasons },
    maintenance: maintenance && { due: maintenance.due, reasons: maintenance.reasons, actionRequired: maintenance.actionRequired },
    consent: checkedConsent && { id: checkedConsent.id, state: checkedConsent.state, scopeCovered: checkedConsent.scopeCovered, reasons: checkedConsent.reasons },
  };
}

function decodeBase64(value) {
  let encoded = value.trim();
  if (encoded.startsWith('data:')) {
    check(/^data:image\/png;base64,/i.test(encoded), 'INVALID_BASE64', 'Only PNG base64 data URLs are supported');
    encoded = encoded.slice(encoded.indexOf(',') + 1);
  }
  encoded = encoded.replace(/\s/g, '');
  check(encoded.length > 0 && encoded.length <= Math.ceil(MAX_PNG / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded) && encoded.length % 4 !== 1, 'INVALID_BASE64', 'Invalid or oversized base64 PNG');
  check(!encoded.includes('=') || encoded.length % 4 === 0, 'INVALID_BASE64', 'Invalid base64 padding');
  const bytes = Buffer.from(encoded, 'base64');
  check(bytes.toString('base64').replace(/=+$/, '') === encoded.replace(/=+$/, ''), 'INVALID_BASE64', 'Base64 PNG is malformed or truncated');
  check(bytes.length <= MAX_PNG, 'INPUT_TOO_LARGE', 'PNG exceeds 100 MiB');
  return bytes;
}

export function extractExport(input) {
  const candidates = new Map();
  let visited = 0;
  function visit(value, depth = 0, explicit = false) {
    check(depth <= 16 && ++visited <= 30_000, 'INVALID_EXPORT', 'Export response nesting or item count exceeds the limit');
    if (typeof value === 'string') {
      const text = value.trim();
      if (/^[{[\"]/.test(text)) {
        try { const parsed = JSON.parse(text); visit(parsed, depth + 1, explicit); return; }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      if (explicit || text.startsWith('iVBOR') || /^data:image\//i.test(text)) {
        const bytes = decodeBase64(text);
        candidates.set(hash(bytes), bytes);
      }
    } else if (Array.isArray(value)) value.forEach(entry => visit(entry, depth + 1));
    else if (object(value)) {
      check(value.isError !== true, 'REMOTE_EXPORT_ERROR', 'MCP reported an export error');
      for (const [key, entry] of Object.entries(value)) {
        visit(entry, depth + 1, ['base64', 'imageBase64', 'imageData', 'png'].includes(key) || key === 'data' && (value.type === 'image' || value.mimeType === 'image/png'));
      }
    }
  }
  if (typeof input === 'string') visit(input, 0, !/^[{[\"]/.test(input.trim()));
  else visit(input);
  check(candidates.size === 1, 'INVALID_EXPORT', candidates.size ? 'Multiple different PNGs found; save one export response at a time' : 'No PNG base64 found in export response; URLs are not fetched');
  return [...candidates.values()][0];
}

export async function validatePng(bytes) {
  check(bytes.length <= MAX_PNG && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'INVALID_PNG', 'Export must be a PNG, maximum 100 MiB');
  // A decoder may tolerate a missing IEND; require a complete PNG container as well.
  let offset = 8; let ended = false; let dataSeen = false;
  while (offset < bytes.length) {
    check(offset + 12 <= bytes.length, 'INVALID_PNG', 'Truncated PNG chunk');
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    check(length <= bytes.length - offset - 12, 'INVALID_PNG', 'Truncated PNG payload');
    if (offset === 8) check(type === 'IHDR' && length === 13, 'INVALID_PNG', 'PNG must start with IHDR');
    if (type === 'IDAT') dataSeen = true;
    offset += length + 12;
    if (type === 'IEND') { check(length === 0 && offset === bytes.length && dataSeen, 'INVALID_PNG', 'Invalid PNG end'); ended = true; break; }
  }
  check(ended, 'INVALID_PNG', 'PNG is missing its end chunk');
  try {
    const sharp = requireTool('sharp');
    const decoder = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_PIXELS });
    const metadata = await decoder.metadata();
    check(metadata.format === 'png' && (metadata.pages ?? 1) === 1, 'INVALID_PNG', 'Only single-frame PNG exports are supported');
    const { data, info } = await decoder.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { pixels: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
  } catch (error) {
    if (error.code === 'INVALID_PNG') throw error;
    fail('INVALID_PNG', 'PNG cannot be fully decoded, exceeds 40 million pixels, or PNG dependencies are unavailable');
  }
}

export async function writeNewFiles(store, entries) {
  const opened = [];
  try {
    for (const entry of entries) {
      const target = await store.localPath(entry.path, { createParents: true });
      const handle = await fs.open(target, 'wx');
      opened.push({ handle, target });
    }
    for (let index = 0; index < entries.length; index++) {
      await opened[index].handle.writeFile(entries[index].bytes);
      await opened[index].handle.sync();
    }
  } catch (error) {
    for (const item of opened) { await item.handle.close(); await fs.unlink(item.target).catch(() => {}); }
    if (error.code === 'EEXIST') fail('ALREADY_EXISTS', 'Output exists; choose a fresh output path');
    throw error;
  }
  await Promise.all(opened.map(item => item.handle.close()));
}

export async function compressPng(bytes, { allowResize = false, losslessOnly = false } = {}) {
  const decoded = await validatePng(bytes);
  const { compressRgba } = await import('../png-under-200k/src/compress-core.js');
  const sharp = requireTool('sharp');
  const result = await compressRgba({ ...decoded, targetBytes: 204_800, allowResize: allowResize && !losslessOnly, losslessOnly,
    resizeRgba: async (pixels, width, height, nextWidth, nextHeight) => new Uint8ClampedArray(await sharp(Buffer.from(pixels), { raw: { width, height, channels: 4 } }).resize(nextWidth, nextHeight, { fit: 'fill', kernel: sharp.kernel.lanczos3 }).raw().toBuffer()),
  });
  check(result.withinTarget, 'COMPRESSION_FAILED', 'PNG cannot reach 204800 bytes with these options; dimensions are preserved by default');
  const png = Buffer.from(result.png);
  const verified = await validatePng(png);
  return { png, width: verified.width, height: verified.height, method: result.method };
}

export async function saveExport(root, input, { output, compress, receipt: receiptPath, kind = 'preview', allowResize = false, losslessOnly = false } = {}) {
  check(['trial', 'preview', 'production'].includes(kind), 'INVALID_INPUT', 'kind must be trial, preview, or production');
  const store = new HandoffStore(root);
  check(typeof output === 'string' && output.endsWith('.png') && (!compress || compress.endsWith('.png')), 'INVALID_INPUT', 'Use explicit .local/ PNG output paths');
  await store.localPath(output, { createParents: true });
  if (compress) await store.localPath(compress, { createParents: true });
  receiptPath ??= `${output}.receipt.json`;
  await store.localPath(receiptPath, { createParents: true });
  const bytes = extractExport(input);
  const decoded = await validatePng(bytes);
  const receipt = (relative, png, size) => ({ path: relative, width: size.width, height: size.height, bytes: png.length, sha256: hash(png) });
  const raw = receipt(output, bytes, decoded);
  const entries = [{ path: output, bytes }];
  let final = null;
  if (compress) {
    const result = await compressPng(bytes, { allowResize, losslessOnly });
    const png = result.png;
    final = { ...receipt(compress, png, result), method: result.method };
    entries.push({ path: compress, bytes: png });
  }
  const result = { kind, savedAt: new Date().toISOString(), authorizationVerified: false, visualReviewVerified: false, raw, final, receiptPath };
  entries.push({ path: receiptPath, bytes: Buffer.from(canonical(result) + '\n') });
  await writeNewFiles(store, entries);
  return result;
}

function observation(input) {
  check(object(input) && object(input.nodes) && Object.keys(input.nodes).length > 0 && Object.values(input.nodes).every(object), 'INVALID_OBSERVATION', 'Supply actual observed nodes as a nonempty object keyed by stable node ID');
  check(input.capturedAt === undefined || typeof input.capturedAt === 'string' && Number.isFinite(Date.parse(input.capturedAt)), 'INVALID_OBSERVATION', 'capturedAt must be a timestamp when supplied');
  const { capturedAt, sourceVersion, ...observed } = input;
  return { schemaVersion: 1, kind: 'design-observation', capturedAt: capturedAt ?? new Date().toISOString(), ...(sourceVersion !== undefined ? { sourceVersion } : {}), sha256: hash(canonical(observed)), observation: observed };
}

export async function snapshot(root, input, output) {
  const record = observation(input);
  const bytes = Buffer.from(canonical(record) + '\n');
  check(bytes.length <= 2 * 1024 * 1024, 'INPUT_TOO_LARGE', 'Snapshot exceeds 2 MiB');
  await writeNewFiles(new HandoffStore(root), [{ path: output, bytes }]);
  return { path: output, sha256: record.sha256, nodes: Object.keys(record.observation.nodes).length };
}

const pointerKey = key => key.replace(/~/g, '~0').replace(/\//g, '~1');
export function compareSnapshots(before, after, allow = []) {
  for (const record of [before, after]) {
    check(record?.schemaVersion === 1 && record.kind === 'design-observation' && record.sha256 === observation(record.observation).sha256, 'INVALID_SNAPSHOT', 'Snapshot structure or content hash is invalid');
  }
  check(Array.isArray(allow) && allow.every(value => typeof value === 'string' && /^\/(?:[^~]|~[01])*$/.test(value) && value !== '/'), 'INVALID_ALLOW_PATH', 'Allow paths must be explicit JSON Pointers, e.g. /nodes/synthetic-text/characters');
  const changes = [];
  function diff(left, right, pointer) {
    if (canonical(left) === canonical(right)) return;
    if (object(left) && object(right) || Array.isArray(left) && Array.isArray(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) diff(left[key], right[key], `${pointer}/${pointerKey(key)}`);
    } else changes.push({ path: pointer, change: left === undefined ? 'added' : right === undefined ? 'removed' : 'changed', ...(left !== undefined ? { before: left } : {}), ...(right !== undefined ? { after: right } : {}), allowed: allow.some(path => pointer === path || pointer.startsWith(path + '/')) });
  }
  diff(before.observation, after.observation, '');
  return { equal: changes.length === 0, assertionApplied: allow.length > 0, allowedChangesOnly: allow.length ? changes.every(change => change.allowed) : null, beforeSha256: before.sha256, afterSha256: after.sha256, changes };
}

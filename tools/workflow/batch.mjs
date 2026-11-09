import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { HandoffStore } from '../handoff/store.mjs';
import { canonical, validatePng, compressPng, writeNewFiles } from './workflow.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const check = (value, code, message) => { if (!value) fail(code, message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fact = (path, bytes, size) => ({ path, sha256: hash(bytes), bytes: bytes.length, width: size.width, height: size.height });

async function validateManifest(store, manifest, output) {
  check(object(manifest) && Array.isArray(manifest.items) && manifest.items.length > 0 && manifest.items.length <= 1000, 'INVALID_MANIFEST', 'Provide 1–1000 explicit items with rawPath and outputName');
  const names = new Set();
  for (const item of manifest.items) {
    check(object(item) && typeof item.rawPath === 'string' && typeof item.outputName === 'string' && /^[^/\\]+\.png$/i.test(item.outputName), 'INVALID_MANIFEST', 'Each item needs rawPath and a single PNG outputName, not a directory');
    check(!names.has(item.outputName.toLowerCase()), 'DUPLICATE_OUTPUT', 'Output names must be unique, including case aliases');
    names.add(item.outputName.toLowerCase());
    await store.localPath(item.rawPath, { allowMissingParents: true });
    await store.localPath(`${output}/${item.outputName}`, { createParents: false });
  }
  check(Buffer.byteLength(canonical(manifest)) <= 1024 * 1024, 'INVALID_MANIFEST', 'Batch manifest exceeds 1 MiB');
}

async function persist(store, reportPath, report) {
  check(Buffer.byteLength(canonical(report)) <= 2 * 1024 * 1024, 'BATCH_TOO_LARGE', 'Batch report exceeds 2 MiB; use a smaller batch');
  const temp = `${reportPath}.tmp-${randomUUID()}`;
  const target = await store.localPath(reportPath);
  await writeNewFiles(store, [{ path: temp, bytes: Buffer.from(canonical(report) + '\n') }]);
  try { await store.localPath(reportPath); await fs.rename(await store.localPath(temp), target); }
  finally { await fs.unlink(await store.localPath(temp)).catch(() => {}); }
}

export async function batchExport(root, { input, output, resume = false } = {}) {
  const store = new HandoffStore(root);
  const supplied = await store.readInput(input);
  let report;
  if (resume && supplied?.kind === 'export-batch') {
    report = supplied;
    check(!output || output === report.outputDirectory, 'INVALID_BATCH', 'Output directory differs from recorded batch');
    output = report.outputDirectory;
    check(input === `${output}/report.json`, 'INVALID_BATCH', 'Resume from this batch report.json');
  } else if (resume) {
    check(typeof output === 'string', 'INVALID_BATCH', 'Resuming from a manifest requires --output for its existing directory');
    report = await store.readInput(`${output}/report.json`);
    check(hash(canonical(supplied)) === report.manifestSha256, 'MANIFEST_CHANGED', 'Manifest differs; create a new batch for changed selections');
  }
  check(typeof output === 'string', 'INVALID_BATCH', 'An explicit .local output directory is required');
  const directory = await store.localPath(output, { createParents: true });
  if (!resume) {
    // Create only a new directory; remove it if initial manifest validation fails.
    const names = supplied?.items?.map(item => item?.outputName);
    check(Array.isArray(names) && names.length > 0, 'INVALID_MANIFEST', 'Provide explicit items');
    try { await fs.mkdir(directory); }
    catch (error) { if (error.code === 'EEXIST') fail('ALREADY_EXISTS', 'Batch output directory already exists; choose a new directory or resume its report'); throw error; }
    try { await validateManifest(store, supplied, output); }
    catch (error) { await fs.rmdir(directory); throw error; }
    report = { schemaVersion: 1, kind: 'export-batch', createdAt: new Date().toISOString(), outputDirectory: output, manifest: supplied, manifestSha256: hash(canonical(supplied)), preserveDimensions: true, items: supplied.items.map(item => ({ rawPath: item.rawPath, outputName: item.outputName, status: 'pending' })) };
    await writeNewFiles(store, [{ path: `${output}/manifest.json`, bytes: Buffer.from(canonical(supplied) + '\n') }, { path: `${output}/report.json`, bytes: Buffer.from(canonical(report) + '\n') }]);
  }
  check(report?.schemaVersion === 1 && report.kind === 'export-batch' && report.outputDirectory === output && report.preserveDimensions === true && report.manifestSha256 === hash(canonical(report.manifest)) && Array.isArray(report.items) && report.items.length === report.manifest.items.length, 'INVALID_BATCH', 'Batch report is invalid');
  await validateManifest(store, report.manifest, output);
  const lockPath = await store.localPath(`${output}/batch.lock`);
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') fail('BUSY', 'Batch is in use; do not remove lock unless its process stopped'); throw error; }
  let skipped = 0;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    // A competing run may have finished after our initial read but before lock acquisition.
    report = await store.readInput(`${output}/report.json`);
    check(report?.schemaVersion === 1 && report.kind === 'export-batch' && report.outputDirectory === output && report.preserveDimensions === true && report.manifestSha256 === hash(canonical(report.manifest)) && Array.isArray(report.items) && report.items.length === report.manifest.items.length, 'INVALID_BATCH', 'Latest batch report is invalid');
    if (resume && supplied?.kind !== 'export-batch') check(hash(canonical(supplied)) === report.manifestSha256, 'MANIFEST_CHANGED', 'Manifest differs from the latest batch report');
    await validateManifest(store, report.manifest, output);
    for (let index = 0; index < report.items.length; index++) {
      const item = report.items[index]; const specified = report.manifest.items[index];
      check(item.rawPath === specified.rawPath && item.outputName === specified.outputName, 'INVALID_BATCH', 'Batch item does not match manifest');
      const finalPath = `${output}/${item.outputName}`;
      try {
        const bytes = await store.readPrivate(item.rawPath, 100 * 1024 * 1024);
        if (item.raw && item.raw.sha256 !== hash(bytes)) fail('INPUT_CHANGED', 'Input differs from recorded batch; create a new batch instead of reusing old results');
        const decoded = await validatePng(bytes);
        item.raw = fact(item.rawPath, bytes, decoded);
        if (item.final) {
          check(item.final.path === finalPath, 'INVALID_BATCH', 'Recorded output path differs from manifest');
          let existing;
          try { existing = await store.readPrivate(finalPath, 204800); await validatePng(existing); }
          catch { fail('OUTPUT_DAMAGED', 'Completed output is missing, oversized or unreadable; create a new batch'); }
          check(hash(existing) === item.final.sha256, 'OUTPUT_DAMAGED', 'Completed output differs from receipt; create a new batch');
          item.status = 'complete'; delete item.error; skipped++;
        } else {
          const result = await compressPng(bytes);
          await writeNewFiles(store, [{ path: finalPath, bytes: result.png }]);
          item.final = { ...fact(finalPath, result.png, result), method: result.method };
          item.status = 'complete'; delete item.error;
        }
      } catch (error) { item.status = 'failed'; item.error = { code: error.code ?? 'ITEM_FAILED', message: error.message }; }
      report.updatedAt = new Date().toISOString();
      await persist(store, `${output}/report.json`, report);
    }
  } finally { await lock.close(); await fs.unlink(lockPath); }
  const complete = report.items.filter(item => item.status === 'complete').length;
  return { complete: complete === report.items.length, total: report.items.length, succeeded: complete, failed: report.items.length - complete, skipped, reportPath: `${output}/report.json`, manifestPath: `${output}/manifest.json`, pngPaths: report.items.filter(item => item.status === 'complete').map(item => item.final.path) };
}

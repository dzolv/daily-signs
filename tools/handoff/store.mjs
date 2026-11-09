import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

export class HandoffError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new HandoffError(code, message); };
const check = (condition, message) => { if (!condition) fail('INVALID_INPUT', message); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const str = (v, label) => { check(typeof v === 'string' && v.trim().length > 0 && v.length <= 10000, `${label} must be a nonempty string (maximum 10000 characters)`); return v; };
const list = (v, label) => { check(Array.isArray(v) && v.length <= 1000, `${label} must be an array (maximum 1000 items)`); return v; };
const id = v => { check(typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(v), 'Invalid identifier'); return v; };
const canonical = value => JSON.stringify(value, (_, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const digest = v => createHash('sha256').update(canonical(v)).digest('hex');
const now = () => new Date().toISOString();
const copy = v => JSON.parse(JSON.stringify(v));
const provenance = (v, label) => {
  check(object(v) && ['unknown', 'verified'].includes(v.status), `${label} must explicitly state status unknown or verified`);
  if (v.status === 'verified') str(v.evidence, `${label}.evidence`);
  return { status: v.status, ...(v.evidence ? { evidence: str(v.evidence, `${label}.evidence`) } : {}) };
};
const unique = (items, label) => check(new Set(items).size === items.length, `${label} contains duplicate identifiers`);

export class HandoffStore {
  constructor(root) { this.root = path.resolve(root); this.local = path.join(this.root, '.local'); }

  // Reject every symlink/junction component, including .local itself. Private data never leaves .local.
  async localPath(relative, { createParents = false } = {}) {
    check(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) && !relative.includes('\\') && !relative.includes(':') && !relative.includes('\0'), 'Use a repository-relative .local/ path with forward slashes');
    const parts = relative.split('/');
    check(parts[0] === '.local' && parts.length > 1 && parts.every(p => p && p !== '.' && p !== '..'), 'Path must remain inside .local/');
    check(parts.every(p => !/[ .]$/.test(p) && !/[<>"|?*]/.test(p) && !/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\..*)?$/i.test(p)), 'Path contains a Windows alias or reserved component');
    let current = this.root;
    const rootInfo = await fs.lstat(current);
    check(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'Repository root must be a real directory');
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let info;
      try { info = await fs.lstat(current); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (createParents && i < parts.length - 1) {
          try { await fs.mkdir(current); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
          info = await fs.lstat(current);
        } else if (i < parts.length - 1) fail('INVALID_PATH', 'Parent directory does not exist');
      }
      if (info) {
        check(!info.isSymbolicLink(), 'Symlinks and junctions are not allowed in private paths');
        if (i < parts.length - 1) check(info.isDirectory(), 'Parent path must be a directory');
      }
    }
    return current;
  }

  async readPrivateDetails(relative, maxBytes = 2 * 1024 * 1024) {
    const target = await this.localPath(relative);
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat({ bigint: true });
      check(info.isFile() && info.size <= maxBytes, `File must be a regular file no larger than ${maxBytes} bytes`);
      const bytes = await handle.readFile();
      check(bytes.length <= maxBytes, `File must be no larger than ${maxBytes} bytes`);
      const normalizedPath = process.platform === 'win32' ? target.toLowerCase() : target;
      return { bytes, normalizedPath, identity: info.ino === 0n ? normalizedPath : `${info.dev}:${info.ino}` };
    } finally { await handle.close(); }
  }

  async readPrivate(relative, maxBytes = 2 * 1024 * 1024) {
    return (await this.readPrivateDetails(relative, maxBytes)).bytes;
  }

  async readInput(relative) {
    try { return JSON.parse((await this.readPrivate(relative)).toString('utf8')); }
    catch (error) { if (error instanceof SyntaxError) fail('INVALID_JSON', 'Input is not valid JSON'); throw error; }
  }

  async state(job) {
    const data = JSON.parse((await this.readPrivate(`.local/handoff/${id(job)}/state.json`, 32 * 1024 * 1024)).toString('utf8'));
    check(data.schemaVersion === 1 && data.id === job && Number.isSafeInteger(data.revision), 'Invalid stored job');
    return data;
  }

  async mutate(job, revision, command, action, { create = false } = {}) {
    id(job);
    if (!create) check(Number.isSafeInteger(revision) && revision >= 1, 'A positive integer revision is required');
    const base = `.local/handoff/${job}`;
    const lockPath = await this.localPath(`${base}/lock`, { createParents: true });
    let lock;
    try { lock = await fs.open(lockPath, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') fail('BUSY', 'Another writer holds the job lock; retry after it finishes'); throw error; }
    let temp;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: now() }));
      let state;
      if (create) {
        const statePath = await this.localPath(`${base}/state.json`);
        try { await fs.lstat(statePath); fail('ALREADY_EXISTS', 'Job already exists'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        state = { schemaVersion: 1, id: job, revision: 0, createdAt: now(), phase: 'planning', snapshots: [], preferences: [], proposals: [], selections: [], claims: [], steps: [], deliveries: [], history: [], snapshotId: null, selectionId: null, activeClaim: null };
      } else {
        state = await this.state(job);
        if (state.revision !== revision) fail('STALE_REVISION', `Expected revision ${revision}; current revision is ${state.revision}`);
      }
      const event = await action(state);
      state.revision++;
      state.updatedAt = now();
      state.history.push({ revision: state.revision, command, at: state.updatedAt, ...event });
      const serialized = JSON.stringify(state, null, 2) + '\n';
      check(Buffer.byteLength(serialized) <= 32 * 1024 * 1024, 'Job exceeds the 32 MiB state limit; start another task');
      const statePath = await this.localPath(`${base}/state.json`);
      temp = await this.localPath(`${base}/tmp-${randomUUID()}.json`);
      const handle = await fs.open(temp, 'wx');
      try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temp, statePath);
      return this.context(state);
    } finally {
      if (temp) await fs.unlink(temp).catch(() => {});
      await lock.close();
      await fs.unlink(lockPath);
    }
  }

  context(state) {
    const snapshot = state.snapshots.find(s => s.id === state.snapshotId) || null;
    const selection = state.selections.find(s => s.id === state.selectionId) || null;
    const observation = state.history.findLast(e => e.command === 'capture');
    return { schemaVersion: 1, id: state.id, revision: state.revision, phase: state.phase, brief: state.brief, constraints: state.constraints, expectedOutputCount: state.expectedOutputCount, preferences: state.preferences, snapshot, sourceObservation: observation ? { capturedAt: observation.observedAt, sourceVersion: observation.sourceVersion, revision: observation.revision } : null, selection, priorSelection: !selection ? state.selections.at(-1) || null : null, needsSelectionReview: Boolean(snapshot && !selection && state.selections.length), proposals: state.proposals.filter(p => p.snapshotId === state.snapshotId), activeClaim: state.activeClaim, steps: state.steps, deliveries: state.deliveries, history: state.history, retained: { snapshots: state.snapshots.length, selections: state.selections.length, claims: state.claims.length }, next: !snapshot ? 'capture' : !selection ? 'select' : state.phase === 'complete' ? 'complete' : state.activeClaim ? state.phase === 'blocked' ? 'resume' : 'record or finish' : 'claim' };
  }

  async run(command, job, { revision, input, worker, token } = {}) {
    if (['status', 'handoff'].includes(command)) return this.context(await this.state(job));
    const commands = ['init', 'capture', 'propose', 'select', 'claim', 'record', 'resume', 'release', 'finish'];
    check(commands.includes(command), 'Unknown command');
    return this.mutate(job, revision, command, async s => {
      const requireInput = () => check(object(input), 'A JSON input object is required');
      const snapshot = () => { const v = s.snapshots.find(x => x.id === s.snapshotId); check(v, 'Capture a source snapshot first'); return v; };
      const invalidate = reason => { if (s.activeClaim) { s.claims.find(c => c.token === s.activeClaim.token).endedAt = now(); s.claims.find(c => c.token === s.activeClaim.token).endReason = reason; } s.activeClaim = null; s.phase = 'planning'; };
      const claim = () => {
        check(s.activeClaim && s.activeClaim.worker === worker && s.activeClaim.token === token, 'Worker and token must match the active claim');
        check(s.activeClaim.snapshotId === s.snapshotId && s.activeClaim.selectionId === s.selectionId, 'Claim no longer matches current source and selection');
        return s.activeClaim;
      };
      const verifySelectedAssets = async () => {
        const selection = s.selections.find(v => v.id === s.selectionId);
        check(selection, 'Record a selection before execution');
        for (const asset of snapshot().assets.filter(a => selection.assetIds.includes(a.id) && a.localPath)) {
          const bytes = await this.readPrivate(asset.localPath, 100 * 1024 * 1024);
          if (createHash('sha256').update(bytes).digest('hex') !== asset.localSha256) fail('STALE_ASSET', 'A selected local asset changed; capture the source again and review its selection');
        }
      };
      if (command === 'init') {
        requireInput(); s.brief = str(input.brief, 'brief');
        s.constraints = list(input.constraints, 'constraints').map(x => str(x, 'constraint'));
        check(input.expectedOutputCount === undefined || (Number.isSafeInteger(input.expectedOutputCount) && input.expectedOutputCount >= 1 && input.expectedOutputCount <= 1000), 'expectedOutputCount must be an integer from 1 to 1000');
        s.expectedOutputCount = input.expectedOutputCount ?? null;
        s.preferences = list(input.preferenceEvidence || [], 'preferenceEvidence').map(v => { check(object(v), 'Invalid preference evidence'); check(['confirmed', 'inferred'].includes(v.certainty), 'Preference certainty must be confirmed or inferred'); return { id: id(v.id), certainty: v.certainty, observation: str(v.observation, 'observation'), evidence: str(v.evidence, 'evidence'), provenance: provenance(v.provenance, 'preference provenance') }; });
        unique(s.preferences.map(p => p.id), 'preferences');
        return {};
      }
      if (command === 'capture') {
        requireInput();
        check(['figma', 'pixso', 'local'].includes(input.provider), 'provider must be figma, pixso, or local');
        str(input.capturedAt, 'capturedAt'); check(Number.isFinite(Date.parse(input.capturedAt)), 'capturedAt must be a timestamp');
        const normalized = { provider: input.provider, documentRef: str(input.documentRef, 'documentRef'), nodeRefs: list(input.nodeRefs, 'nodeRefs').map(x => str(x, 'nodeRef')), text: list(input.text, 'text').map(x => str(x, 'text item')), targetFingerprint: str(input.targetFingerprint, 'targetFingerprint (target layout/style/composition fingerprint)'), assets: [] };
        const targetKey = digest({ provider: normalized.provider, documentRef: normalized.documentRef, nodeRefs: [...new Set(normalized.nodeRefs)].sort() });
        const lastObservation = s.history.findLast(e => e.command === 'capture' && e.targetKey === targetKey);
        if (lastObservation && Date.parse(input.capturedAt) < Date.parse(lastObservation.observedAt)) fail('STALE_OBSERVATION', 'This capture predates the last observation of the same target; observe the source again');
        const sourceVersion = str(input.sourceVersion, 'sourceVersion');
        normalized.assets = await Promise.all(list(input.assets, 'assets').map(async a => {
          check(object(a) && ['reference', 'selected'].includes(a.role), 'Asset role must be reference or selected');
          check(['source-image', 'render'].includes(a.artifactKind), 'Asset artifactKind must be source-image or render');
          const asset = { id: id(a.id), role: a.role, artifactKind: a.artifactKind, sourceRef: str(a.sourceRef, 'asset.sourceRef'), source: provenance(a.source, 'asset.source'), license: provenance(a.license, 'asset.license') };
          if (a.localPath) { const bytes = await this.readPrivate(a.localPath, 100 * 1024 * 1024); asset.localPath = a.localPath; asset.localSha256 = createHash('sha256').update(bytes).digest('hex'); }
          return asset;
        }));
        unique(normalized.assets.map(a => a.id), 'assets');
        const fingerprint = digest(normalized);
        if (s.snapshotId === fingerprint) return { unchanged: true, observedAt: input.capturedAt, sourceVersion, targetKey };
        invalidate('source changed'); s.selectionId = null;
        const existing = s.snapshots.find(v => v.id === fingerprint);
        if (!existing) s.snapshots.push({ id: fingerprint, capturedAt: input.capturedAt, sourceVersion, ...normalized });
        s.snapshotId = fingerprint;
        return { snapshotId: fingerprint, observedAt: input.capturedAt, sourceVersion, targetKey };
      }
      if (command === 'propose') {
        requireInput(); const current = snapshot();
        const alternatives = list(input.alternatives, 'alternatives').map(a => {
          check(object(a), 'Invalid alternative');
          const assetIds = list(a.assetIds, 'alternative.assetIds').map(id);
          check(assetIds.every(x => current.assets.some(v => v.id === x)), 'Alternative references unknown asset');
          const evidence = list(a.evidence, 'alternative.evidence').map(e => { check(object(e), 'Invalid evidence'); check((e.kind === 'snapshot' && e.id === current.id) || (e.kind === 'preference' && s.preferences.some(p => p.id === e.id)), 'Evidence must reference current snapshot or recorded preference'); return { kind: e.kind, id: e.id }; });
          check(evidence.length > 0, 'Alternative needs evidence');
          return { id: id(a.id), description: str(a.description, 'description'), assetIds, evidence };
        });
        check(alternatives.length > 0, 'At least one alternative is required'); unique(alternatives.map(a => a.id), 'alternatives');
        s.proposals.push({ id: randomUUID(), snapshotId: current.id, at: now(), alternatives });
        return { selectionChanged: false };
      }
      if (command === 'select') {
        requireInput(); const current = snapshot();
        const assetIds = list(input.assetIds, 'assetIds').map(id); check(assetIds.length > 0, 'Select at least one asset'); unique(assetIds, 'assetIds');
        check(assetIds.every(x => current.assets.some(a => a.id === x)), 'Selection references unknown asset');
        check(['source', 'user'].includes(input.basis), 'Selection basis must be source or user');
        if (input.basis === 'source') check(assetIds.every(x => current.assets.find(a => a.id === x).role === 'selected'), 'Source evidence does not mark every chosen asset as selected');
        else str(input.confirmation, 'explicit user confirmation');
        let rightsConfirmation;
        if (input.rightsConfirmation !== undefined) { check(object(input.rightsConfirmation) && input.rightsConfirmation.confirmedBy === 'user', 'Existing-source rights must be confirmed by the user'); rightsConfirmation = { confirmedBy: 'user', statement: str(input.rightsConfirmation.statement, 'rights statement'), evidence: str(input.rightsConfirmation.evidence, 'rights evidence') }; }
        const selection = { id: randomUUID(), snapshotId: current.id, assetIds, basis: input.basis, evidence: str(input.evidence, 'selection evidence'), ...(input.basis === 'user' ? { confirmation: input.confirmation } : {}), ...(rightsConfirmation ? { rightsConfirmation } : {}), at: now() };
        invalidate('selection changed'); s.selections.push(selection); s.selectionId = selection.id; s.phase = 'ready'; return { selectionId: selection.id };
      }
      if (command === 'claim') {
        id(worker); snapshot(); check(s.selectionId, 'Record a selection before execution'); check(!s.activeClaim, 'A worker already owns this job'); check(s.phase !== 'complete', 'Job is complete; make a fresh selection to rerun');
        await verifySelectedAssets();
        const active = { worker, token: randomUUID(), snapshotId: s.snapshotId, selectionId: s.selectionId, startedAt: now() };
        s.activeClaim = active; s.claims.push(copy(active)); s.phase = 'active'; return { worker };
      }
      const active = claim();
      if (command === 'release') { invalidate('released'); s.phase = 'ready'; return { worker }; }
      if (command === 'resume') { check(s.phase === 'blocked', 'Only a blocked job can resume'); s.phase = 'active'; return { worker }; }
      check(s.phase === 'active', 'Resume the blocked job before recording or finishing');
      if (command === 'record') {
        requireInput(); check(['step', 'result', 'blocked'].includes(input.kind), 'Record kind must be step, result, or blocked');
        s.steps.push({ id: randomUUID(), claimToken: active.token, snapshotId: s.snapshotId, selectionId: s.selectionId, kind: input.kind, message: str(input.message, 'message'), at: now() });
        if (input.kind === 'blocked') s.phase = 'blocked'; return { worker };
      }
      if (command === 'finish') {
        requireInput(); const outputs = list(input.outputs, 'outputs'); check(outputs.length > 0, 'At least one raw/final output pair is required');
        check(s.expectedOutputCount === null || outputs.length === s.expectedOutputCount, 'Output count does not match expectedOutputCount');
        await verifySelectedAssets();
        check(object(input.review), 'Record visual review before delivery');
        const review = { text: str(input.review.text, 'review.text evidence') };
        if (input.review.exportScale !== undefined) review.exportScale = str(input.review.exportScale, 'review.exportScale evidence');
        else review.raw2x = str(input.review.raw2x, 'review.exportScale (or legacy raw2x) evidence');
        for (const key of ['template', 'crop', 'raw2x']) if (input.review[key] !== undefined) review[key] = str(input.review[key], `review.${key} evidence`);
        const selected = s.selections.find(v => v.id === s.selectionId);
        check(snapshot().assets.filter(a => selected.assetIds.includes(a.id)).every(a => a.license.status === 'verified') || selected.rightsConfirmation, 'Selected asset licensing is unknown; record actual user existing-source rights confirmation or verified license evidence before delivery');
        const sharp = createRequire(new URL('../png-under-200k/package.json', import.meta.url))('sharp');
        const verified = [];
        const seenFiles = new Set(); const seenPaths = new Set();
        for (const pair of outputs) {
          check(object(pair) && pair.rawPath !== pair.finalPath, 'Record distinct raw and final export paths');
          const validate = async (relative, limit) => {
            const file = await this.readPrivateDetails(relative, limit);
            const bytes = file.bytes;
            check(!seenFiles.has(file.identity) && !seenPaths.has(file.normalizedPath), 'Raw and final exports must be distinct physical files, with no duplicates');
            seenFiles.add(file.identity); seenPaths.add(file.normalizedPath);
            const decoder = sharp(bytes, { failOn: 'warning' });
            const metadata = await decoder.metadata(); check(metadata.format === 'png', 'Exports must be PNG images');
            await decoder.raw().toBuffer();
            return { path: relative, bytes: bytes.length, width: metadata.width, height: metadata.height, sha256: createHash('sha256').update(bytes).digest('hex') };
          };
          verified.push({ raw: await validate(pair.rawPath, 100 * 1024 * 1024), final: await validate(pair.finalPath, 204800) });
        }
        unique(verified.map(p => p.final.path), 'final outputs');
        s.deliveries.push({ id: randomUUID(), snapshotId: s.snapshotId, selectionId: s.selectionId, claimToken: active.token, at: now(), review, outputs: verified });
        invalidate('finished'); s.phase = 'complete'; return { worker, verifiedOutputs: verified.length };
      }
    }, { create: command === 'init' });
  }
}

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

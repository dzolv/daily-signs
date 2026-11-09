#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { HandoffStore, repositoryRoot } from '../handoff/store.mjs';
import { preflight, saveExport, snapshot, compareSnapshots, MAX_EXPORT_INPUT } from './workflow.mjs';
import { batchExport } from './batch.mjs';

const usage = `Local workflow helpers (no MCP connection, network, approval, or visual judgement)
  preflight --consent ID --scope .local/scope.json
  preflight --local-only
  save-export --input .local/mcp-return.json|- --output .local/export-raw/name.png
    [--compress .local/export/name.png] [--receipt .local/result.json]
    [--kind trial|preview|production] [--allow-resize] [--lossless-only]
  batch-export --input .local/batch.json --output .local/delivery/NEW-DIRECTORY
  resume-batch --input .local/delivery/DIRECTORY/report.json
  resume-batch --input .local/batch.json --output .local/delivery/DIRECTORY
  snapshot --input .local/observed.json --output .local/snapshots/before.json
  compare --before .local/snapshots/before.json --after .local/snapshots/after.json
    [--allow /nodes/synthetic-text/characters] (repeat --allow for more paths)
All outputs are new files; existing files are never overwritten.
save-export also saves its receipt (default: OUTPUT.receipt.json).
Compression preserves dimensions by default. Batch accepts only explicitly listed PNGs.
Host tools must save the complete MCP return or pipe it to stdin; never manually copy base64.
Snapshot input: {"nodes":{"synthetic-node":{"actualObservedProperty":"value"}}}.
--allow asserts that every change is inside a listed JSON Pointer subtree.
Production is a label, not license/consent verification or a handoff finish.`;

async function readStdin(stream) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > MAX_EXPORT_INPUT) throw Object.assign(new Error('Export input exceeds 140 MiB'), { code: 'INPUT_TOO_LARGE' });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(args = process.argv.slice(2), { root = repositoryRoot, stdin = process.stdin, log = line => console.log(line) } = {}) {
  try {
    if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) { log(usage); return 0; }
    const [command, ...rest] = args;
    const specs = {
      preflight: ['--consent', '--scope', '--local-only'],
      'save-export': ['--input', '--output', '--compress', '--receipt', '--kind', '--no-resize', '--allow-resize', '--lossless-only'],
      'batch-export': ['--input', '--output'], 'resume-batch': ['--input', '--output'],
      snapshot: ['--input', '--output'], compare: ['--before', '--after', '--allow'],
    };
    const flags = {}; const allow = [];
    const invalid = () => { throw Object.assign(new Error('Use --help for workflow command usage'), { code: 'USAGE' }); };
    if (!specs[command]) invalid();
    for (let index = 0; index < rest.length; index++) {
      const key = rest[index];
      if (!specs[command].includes(key) || key !== '--allow' && Object.hasOwn(flags, key)) invalid();
      const value = ['--local-only', '--no-resize', '--allow-resize', '--lossless-only'].includes(key) ? true : rest[++index];
      if (value === undefined || typeof value === 'string' && value.startsWith('--')) invalid();
      if (key === '--allow') allow.push(value); else flags[key] = value;
    }
    const store = new HandoffStore(root);
    let result;
    if (command === 'preflight') {
      if (flags['--local-only'] && (flags['--consent'] || flags['--scope'])) invalid();
      result = await preflight(root, { consent: flags['--consent'], scope: flags['--scope'], localOnly: flags['--local-only'] });
    } else if (command === 'save-export') {
      if (!flags['--input'] || !flags['--output']) invalid();
      const input = flags['--input'] === '-' ? await readStdin(stdin) : (await store.readPrivate(flags['--input'], MAX_EXPORT_INPUT)).toString('utf8');
      if (flags['--allow-resize'] && flags['--no-resize']) invalid();
      result = await saveExport(root, input, { output: flags['--output'], compress: flags['--compress'], receipt: flags['--receipt'], kind: flags['--kind'], allowResize: Boolean(flags['--allow-resize']), losslessOnly: Boolean(flags['--lossless-only']) });
    } else if (command === 'batch-export' || command === 'resume-batch') {
      if (!flags['--input'] || command === 'batch-export' && !flags['--output']) invalid();
      result = await batchExport(root, { input: flags['--input'], output: flags['--output'], resume: command === 'resume-batch' });
    } else if (command === 'snapshot') {
      if (!flags['--input'] || !flags['--output']) invalid();
      result = await snapshot(root, await store.readInput(flags['--input']), flags['--output']);
    } else {
      if (!flags['--before'] || !flags['--after']) invalid();
      result = compareSnapshots(await store.readInput(flags['--before']), await store.readInput(flags['--after']), allow);
    }
    log(JSON.stringify({ ok: true, ...result }));
    return result.ready === false || result.allowedChangesOnly === false || result.complete === false ? 1 : 0;
  } catch (error) {
    log(JSON.stringify({ ok: false, error: { code: error.code ?? 'OPERATION_FAILED', message: error.message } }));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();

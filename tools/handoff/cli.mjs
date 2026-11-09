#!/usr/bin/env node
import { HandoffStore, HandoffError, repositoryRoot } from './store.mjs';
import { readMaintenanceStatus } from '../maintenance/dependencies.mjs';
import { readSetupStatus, unavailableSetupStatus } from '../setup/permissions-notice.mjs';

const help = `Local daily-sign handoff (no external connections)
Usage: node tools/handoff/cli.mjs COMMAND JOB [options]
Commands: init capture propose select claim record resume release finish status handoff
  --input .local/path.json    JSON payload (init/capture/propose/select/record/finish)
  --revision N               Required for every mutation after init
  --worker ID --token TOKEN  Claim owner (claim only needs --worker)
Read tools/handoff/README.md for payloads, recovery, and boundaries.
`;

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(help); }
  else {
    const [command, job, ...rest] = args;
    if (!command || !job) throw new HandoffError('USAGE', 'Command and job ID are required; use --help');
    const flags = {};
    for (let i = 0; i < rest.length; i += 2) {
      const name = rest[i]; const value = rest[i + 1];
      if (!['--input', '--revision', '--worker', '--token'].includes(name) || !value || value.startsWith('--') || flags[name] !== undefined) throw new HandoffError('USAGE', 'Unknown, duplicate, or incomplete option');
      flags[name] = value;
    }
    const readOnly = ['status', 'handoff'].includes(command);
    const needsInput = ['init', 'capture', 'propose', 'select', 'record', 'finish'].includes(command);
    if (needsInput !== Boolean(flags['--input'])) throw new HandoffError('USAGE', needsInput ? 'This command needs --input' : 'This command does not accept --input');
    if ((readOnly || command === 'init') && (flags['--revision'] || flags['--worker'] || flags['--token'])) throw new HandoffError('USAGE', 'Unexpected mutation options');
    if (flags['--revision'] && !/^[1-9][0-9]*$/.test(flags['--revision'])) throw new HandoffError('USAGE', 'Revision must be a positive integer');
    const store = new HandoffStore(repositoryRoot);
    const result = await store.run(command, job, { revision: flags['--revision'] ? Number(flags['--revision']) : undefined, input: flags['--input'] ? await store.readInput(flags['--input']) : undefined, worker: flags['--worker'], token: flags['--token'] });
    // Startup/resumption reports maintenance to the model without network access or
    // mixing human notices into the machine-readable output. Production steps do
    // not interrupt a batch to install packages.
    let maintenance;
    let setup;
    if (['init', 'status', 'handoff'].includes(command)) {
      try { maintenance = await readMaintenanceStatus(repositoryRoot); }
      catch { maintenance = { due: true, actionRequired: true, instructions: 'Dependency status unavailable. Check with npm run deps:status between production batches.' }; }
      try { setup = await readSetupStatus(repositoryRoot); }
      catch (error) { setup = unavailableSetupStatus(error); }
    }
    process.stdout.write(JSON.stringify({ ok: true, ...result, ...(maintenance ? { maintenance } : {}), ...(setup ? { setup } : {}) }) + '\n');
  }
} catch (error) {
  const code = error instanceof HandoffError ? error.code : error.code === 'ENOENT' ? 'NOT_FOUND' : 'OPERATION_FAILED';
  // JSON errors omit stacks and OS path details; no credential-bearing payloads are echoed.
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message: error instanceof HandoffError ? error.message : code === 'NOT_FOUND' ? 'A required local file does not exist' : 'Local operation failed; check paths, installed dependencies, and image readability' } }) + '\n');
  process.exitCode = 1;
}

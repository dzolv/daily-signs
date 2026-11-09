#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConsentStore, ConsentError, consentBoundary } from './consent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const usage = `Local consent records (no account connections or configuration changes)
  propose --input .local/scope.json
  decide ID --revision N --decision approved|denied|revoked --evidence "实际用户回复记录"
  status ID
  check ID --input .local/requested-scope.json
Propose only creates a pending question: ask the user and wait for an explicit reply.
Record existing explicit session authorization with its actual evidence; do not ask again.
Records cannot independently verify a human or replace host/OAuth approvals.
Use account labels and private target references; never include credentials.
Scope JSON requires accountRef, documentRef, nodeRefs[], actions[], tools[], localPaths[], purpose.
Actions: read, edit, create, export, local-write. See docs/pixso-permissions.md for examples.`;
const invalid = () => { throw new ConsentError('USAGE', 'Use --help for consent command usage'); };
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) console.log(usage);
  else {
    const command = args.shift();
    if (!['propose', 'decide', 'status', 'check'].includes(command)) invalid();
    const id = command === 'propose' ? undefined : args.shift();
    const expected = command === 'propose' || command === 'check' ? ['--input'] : command === 'decide' ? ['--revision', '--decision', '--evidence'] : [];
    const flags = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index]; const value = args[index + 1];
      if (!expected.includes(key) || Object.hasOwn(flags, key) || value === undefined) invalid();
      flags[key] = value;
    }
    if (Object.keys(flags).length !== expected.length || (command !== 'propose' && !id)) invalid();
    const store = new ConsentStore(root);
    let result;
    if (command === 'propose' || command === 'check') {
      const scope = await store.readInput(flags['--input']);
      result = command === 'propose' ? await store.propose(scope) : await store.check(id, scope);
    } else if (command === 'status') result = await store.status(id);
    else {
      if (!/^[1-9][0-9]*$/.test(flags['--revision'])) invalid();
      result = await store.decide(id, { revision: Number(flags['--revision']), decision: flags['--decision'], evidence: flags['--evidence'] });
    }
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
    if (result.scopeCovered === false) process.exitCode = 1;
  }
} catch (error) {
  const code = error instanceof ConsentError ? error.code : ['ENOENT', 'INVALID_JSON', 'INVALID_INPUT', 'INVALID_PATH'].includes(error.code) ? error.code : 'OPERATION_FAILED';
  console.log(JSON.stringify({ ok: false, scopeCovered: false, ...consentBoundary, error: { code, message: error instanceof ConsentError ? error.message : 'Cannot read private input or consent record; inspect local paths and JSON. No consent scope was verified.' } }, null, 2));
  process.exitCode = 1;
}

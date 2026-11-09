#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDependencies, readMaintenanceStatus } from './dependencies.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === 'help') {
    console.log('node tools/maintenance/cli.mjs status|check [--days N]\nstatus: offline due-check; check: npm outdated + audit, no installation.');
  } else {
    if (!['status', 'check'].includes(command) || (args.length && (args.length !== 2 || args[0] !== '--days' || !/^\d+$/.test(args[1])))) throw new Error('Usage: node tools/maintenance/cli.mjs status|check [--days N]');
    const days = args.length ? Number(args[1]) : 7;
    const result = command === 'status'
      ? await readMaintenanceStatus(root, new Date(), { days })
      : await checkDependencies(root, { days });
    console.log(JSON.stringify(result, null, 2));
    if (result.ok === false) process.exitCode = 1;
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: { code: error.code ?? 'INVALID_COMMAND', message: error.message } }, null, 2));
  process.exitCode = 1;
}

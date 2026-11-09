#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSetupStatus, acknowledgePermissionsNotice } from './permissions-notice.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const help = 'node tools/setup/cli.mjs status|acknowledge --message "实际向用户说明过的简短文本"\nstatus: offline, read-only notice status. acknowledge: records that the model explained the notice; grants no permissions and verifies no connection. Do not include credentials or private account details.';
try {
  const [command, ...args] = process.argv.slice(2);
  if (['--help', '-h', 'help'].includes(command) && args.length === 0) console.log(help);
  else {
    if (!(command === 'status' && args.length === 0) && !(command === 'acknowledge' && args.length === 2 && args[0] === '--message')) throw Object.assign(new Error('Use --help for setup command usage'), { code: 'USAGE' });
    const result = command === 'status' ? await readSetupStatus(root) : await acknowledgePermissionsNotice(root, { message: args[1] });
    console.log(JSON.stringify({ ok: !result.error, ...result }, null, 2));
    if (result.error) process.exitCode = 1;
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: { code: ['USAGE', 'INVALID_MESSAGE', 'INVALID_TIME', 'INVALID_RECORD', 'UNSAFE_PATH', 'BUSY'].includes(error.code) ? error.code : 'OPERATION_FAILED', message: 'Setup operation failed; check command usage, notice record, and local paths. No permissions or connection were verified.' } }, null, 2));
  process.exitCode = 1;
}

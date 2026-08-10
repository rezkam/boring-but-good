import { spawnSync } from 'node:child_process';

export async function startChrome(options) {
  console.error('browser startup diagnostic');
  spawnSync(process.execPath, ['-e', "process.stderr.write('inherited browser diagnostic\\n')"], {
    stdio: 'inherit',
  });
  return { status: 'started', port: options.port, ownerToken: 'fixture-owner-token' };
}

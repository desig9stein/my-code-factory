// Runs one shell command for lib/evidence.mjs and ends everything it started when it runs out of time.
// A command started directly would lose only its shell at the limit; the test runner or server under it lived on.
//
// Usage: node runcmd.mjs <limit in ms, 0 for none> <file to create at the limit> <command>
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [limit, marker, cmd] = process.argv.slice(2);
// Its own process group, so the whole tree can be signalled at once.
const child = spawn('sh', ['-c', cmd], { stdio: 'inherit', detached: true });
const stop = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Ended already.
  }
};
const timer = Number(limit) > 0
  ? setTimeout(() => {
    fs.writeFileSync(marker, '');
    stop('SIGTERM');
    setTimeout(() => stop('SIGKILL'), 2000).unref();
  }, Number(limit))
  : null;
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stop(signal));
child.on('error', (err) => {
  process.stderr.write(`${err.message}\n`);
  process.exit(127);
});
// What the command left running on purpose, such as a server a setup started, is not touched when it ends in time.
child.on('exit', (code) => {
  clearTimeout(timer);
  process.exit(code ?? 1);
});

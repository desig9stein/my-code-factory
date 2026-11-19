import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = ['bin', 'lib', 'web', 'scripts', 'test'].flatMap(dir => fs.readdirSync(dir, { recursive: true }).filter(file => /\.(mjs|js)$/.test(file)).map(file => `${dir}/${file}`));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const result = spawnSync(process.execPath, ['--test', ...fs.readdirSync('test').filter(file => file.endsWith('.test.mjs')).map(file => `test/${file}`)], { stdio: 'inherit' });
process.exit(result.status || 0);

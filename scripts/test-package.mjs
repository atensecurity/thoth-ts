// Verify the published entrypoints in a clean consumer using native Node.
// Install development dependencies first; the offline install uses npm's cache.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run this check with npm run test:package');
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
const run = (args, cwd) => execFileSync(process.execPath, [npm, ...args], {
  cwd,
  env,
  encoding: 'utf8',
  timeout: 120000,
});
const consumer = mkdtempSync(join(tmpdir(), 'thoth-package-'));

try {
  run(['run', 'build'], source);
  const [packed] = JSON.parse(run([
    'pack', '--ignore-scripts', '--json', '--pack-destination', consumer,
  ], source));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run([
    'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    join(consumer, packed.filename),
  ], consumer);
  writeFileSync(join(consumer, 'probe.mjs'), `
import assert from 'node:assert/strict';
import { instrument, ThothClient, ThothPolicyViolation } from '@atensec/thoth';
import { wrapAnthropicTools } from '@atensec/thoth/anthropic';
import { wrapOpenAITools } from '@atensec/thoth/openai';
for (const exported of [instrument, ThothClient, ThothPolicyViolation, wrapAnthropicTools, wrapOpenAITools]) {
  assert.equal(typeof exported, 'function');
}
console.log('Native Node public exports passed on ' + process.version);
`);
  execFileSync(process.execPath, ['probe.mjs'], {
    cwd: consumer,
    env,
    stdio: 'inherit',
    timeout: 10000,
  });
  copyFileSync(join(source, 'scripts/privacy-probe.mjs'), join(consumer, 'privacy-probe.mjs'));
  execFileSync(process.execPath, ['privacy-probe.mjs'], { cwd: consumer, env, stdio: 'inherit', timeout: 30000 });
} finally {
  rmSync(consumer, { recursive: true, force: true });
}

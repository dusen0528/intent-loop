import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Host CLIs own installation, enablement and trust. Never manufacture trust hashes.
function run(host, args) {
  const result = spawnSync(host, args, { stdio: 'inherit', timeout: 120000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${host} ${args.join(' ')} failed (${result.error?.message ?? result.status}). Install/login to the host CLI as needed, then retry; completed host steps and staged files are retained.`);
  }
}

export function installUserPlugin({ pkg, host, action }) {
  run(host, ['--version']);
  if (action === 'remove') {
    run(host, host === 'codex' ? ['plugin', 'remove', 'intent-loop@intent-loop']
      : ['plugin', 'uninstall', 'intent-loop@intent-loop', '--scope', 'user']);
    console.log('Removed user plugin. Project/session state and marketplace source are retained.');
    return;
  }
  const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?$/.test(version)) throw new Error('Invalid package version');
  const base = os.homedir();
  const root = path.join(base, '.local/share/intent-loop', version);
  const files = ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json',
    '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json',
    'hooks/hooks.json', 'skills/intent-loop/SKILL.md', 'scripts/review_gate.py'];
  const payloads = files.map(name => [name, fs.readFileSync(path.join(pkg, name))]);
  // Preflight every target before creating anything; preserve edits and reject links.
  for (const [name, data] of payloads) {
    const target = path.join(root, name);
    let current = base;
    for (const part of path.relative(base, target).split(path.sep)) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink destination: ${current}`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (fs.existsSync(target) && !fs.readFileSync(target).equals(data)) {
      throw new Error(`Existing different file; not overwritten: ${target}`);
    }
  }
  for (const [name, data] of payloads) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) fs.writeFileSync(target, data, { flag: 'wx' });
  }
  run(host, ['plugin', 'marketplace', 'add', root, ...(host === 'claude' ? ['--scope', 'user'] : [])]);
  run(host, host === 'codex' ? ['plugin', 'add', 'intent-loop@intent-loop']
    : ['plugin', 'install', 'intent-loop@intent-loop', '--scope', 'user']);
  console.log(`Installed user-wide Intent Loop for ${host}; source: ${root}`);
  console.log('State: <working-directory>/.intent-review/<session-hash>.json. Keep .intent-review/ out of Git.');
  console.log('Remove older project or differently named Intent Loop installations to avoid duplicate hooks.');
  console.log(host === 'codex' ? 'Review/trust plugin hooks once in /hooks, then start a new session. Changed definitions require review again.'
    : 'Start a new Claude Code session to load the user plugin.');
}

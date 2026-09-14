import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Host CLIs own installation, enablement and trust. Never manufacture trust hashes.
function run(host, args, capture = false) {
  const result = spawnSync(host, args, { stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${host} ${args.join(' ')} failed (${result.error?.message ?? result.status}). Install/login to the host CLI as needed, then retry; completed host steps and staged files are retained.`);
  }
  return result.stdout;
}

export function assertNoGlobalPlugin(host) {
  const result = JSON.parse(run(host, ['plugin', 'list', '--json'], true));
  const plugins = host === 'codex' ? result.installed : result;
  if (!Array.isArray(plugins)) throw new Error('Could not verify global plugins; project installation left untouched.');
  if (plugins.some(plugin => {
    const id = host === 'codex' ? plugin.pluginId : plugin.id;
    const global = host === 'codex' || ['user', 'managed'].includes(plugin.scope);
    return global && typeof id === 'string' && id.split('@')[0] === 'intent-loop' && plugin.enabled !== false;
  })) {
    throw new Error('An active global Intent Loop plugin is already installed. Disable/remove it in the host before a project installation.');
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
  const files = ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json',
    '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json',
    'hooks/hooks.json', 'skills/intent-loop/SKILL.md', 'scripts/review_gate.py'];
  const payloads = files.map(name => {
    const data = fs.readFileSync(path.join(pkg, name));
    if (name !== 'hooks/hooks.json') return [name, data];
    const config = JSON.parse(data);
    const script = path.join(root, 'scripts/review_gate.py');
    const quoted = "'" + script.replaceAll("'", "'\"'\"'") + "'";
    // Running sessions must not depend on the host's disposable plugin cache.
    for (const groups of Object.values(config.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) hook.command = `python3 -I ${quoted} hook`;
      }
    }
    return [name, Buffer.from(JSON.stringify(config, null, 2) + '\n')];
  });
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
  if (host === 'codex' && action === 'update') {
    const { marketplaces } = JSON.parse(run(host, ['plugin', 'marketplace', 'list', '--json'], true));
    const previous = marketplaces.find(m => m.name === 'intent-loop');
    if (previous && path.resolve(previous.root) !== root) {
      const source = previous.marketplaceSource;
      if (source?.sourceType !== 'local' || path.dirname(path.resolve(source.source)) !== path.dirname(root)
          || path.resolve(source.source) !== path.resolve(previous.root)) {
        throw new Error('Existing intent-loop marketplace is not managed by this installer; source left unchanged.');
      }
      run(host, ['plugin', 'marketplace', 'remove', 'intent-loop']);
    }
  }
  run(host, ['plugin', 'marketplace', 'add', root, ...(host === 'claude' ? ['--scope', 'user'] : [])]);
  run(host, host === 'codex' ? ['plugin', 'add', 'intent-loop@intent-loop']
    : ['plugin', action === 'update' ? 'update' : 'install', 'intent-loop@intent-loop', '--scope', 'user']);
  console.log(`${action === 'update' ? 'Updated' : 'Installed'} user-wide Intent Loop for ${host}; version: ${version}; source: ${root}`);
  console.log('State: <working-directory>/.intent-review/<session-hash>.json. Keep .intent-review/ out of Git.');
  console.log('Remove older project or differently named Intent Loop installations to avoid duplicate hooks.');
  console.log(host === 'codex' ? 'Review/trust plugin hooks once in /hooks, then start a new session. Changed definitions require review again.'
    : 'Start a new Claude Code session to load the user plugin.');
}

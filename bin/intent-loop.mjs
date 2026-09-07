#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { installUserPlugin } from './user-plugin.mjs';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.realpathSync(process.cwd());
const locations = {
  codex: ['.codex/hooks.json', '.agents/skills/intent-loop/SKILL.md'],
  claude: ['.claude/settings.json', '.claude/skills/intent-loop/SKILL.md'],
};
const events = ['UserPromptSubmit', 'PreToolUse', 'SessionStart', 'Stop'];
const runtime = '.intent-loop/review_gate.py';
const quote = text => /^[a-zA-Z0-9_./:-]+$/.test(text) ? text : `'${text.replaceAll("'", `'"'"'`)}'`;
const command = `python3 -I ${quote(path.join(root, runtime))} hook`;
const registration = { hooks: [{ type: 'command', command, timeout: 10 }] };
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function checkPath(relative) {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink destination: ${relative}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return path.join(root, relative);
}

function read(relative) {
  try { return fs.readFileSync(checkPath(relative)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function settings(relative) {
  const bytes = read(relative);
  const value = bytes ? JSON.parse(bytes.toString()) : {};
  if (!object(value) || (value.hooks !== undefined && !object(value.hooks))) {
    throw new Error(`Expected an object in ${relative}`);
  }
  for (const groups of Object.values(value.hooks || {})) {
    if (!Array.isArray(groups) || groups.some(g => !object(g) || !Array.isArray(g.hooks))) {
      throw new Error(`Invalid hook groups in ${relative}`);
    }
  }
  return value;
}

function owned(group) {
  const hook = group.hooks[0];
  return Object.keys(group).length === 1 && group.hooks.length === 1 && object(hook)
    && Object.keys(hook).length === 3 && hook.type === 'command'
    && hook.command === command && hook.timeout === 10;
}

function refersToRuntime(value) {
  return Object.values(value.hooks || {}).some(groups => groups.some(g => g.hooks.some(h =>
    typeof h.command === 'string' && h.command.includes('review_gate.py'))));
}

function apply(changes) {
  const before = new Map([...changes.keys()].map(name => [name, read(name)]));
  const modes = new Map([...before].filter(([, bytes]) => bytes !== null)
    .map(([name]) => [name, fs.statSync(checkPath(name)).mode & 0o777]));
  const created = [], completed = [];
  function write(name, content) {
    const target = checkPath(name);
    if (content === null) { fs.unlinkSync(target); return; }
    const missing = [];
    for (let dir = path.dirname(target); !fs.existsSync(dir); dir = path.dirname(dir)) missing.push(dir);
    for (const dir of missing.reverse()) { fs.mkdirSync(dir); created.push(dir); }
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, content, { flag: 'wx', mode: modes.get(name) ?? 0o666 });
      fs.renameSync(temp, target);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  try {
    for (const [name, content] of changes) {
      const old = before.get(name);
      if (old === null && content === null) continue;
      if (old && content && old.equals(content)) continue;
      write(name, content);
      completed.push(name);
    }
  } catch (error) {
    const failures = [];
    for (const name of completed.reverse()) {
      try { write(name, before.get(name)); } catch (rollback) { failures.push(`${name}: ${rollback.message}`); }
    }
    for (const dir of created.reverse()) {
      try { fs.rmdirSync(dir); } catch { /* Preserve nonempty directories. */ }
    }
    if (failures.length) throw new Error(`${error.message}; rollback incomplete: ${failures.join(', ')}`);
    throw error;
  }
}

function main() {
  const args = process.argv.slice(2);
  const usage = 'Usage: intent-loop <init|remove> --host <codex|claude> [--scope user|project]\nDefault: user-wide plugin; state stays in each working directory/session.';
  if (args.length === 0 || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
    console.log(usage);
    return;
  }
  const [action, flag, host, scopeFlag, scopeValue] = args;
  const scope = scopeValue ?? 'user';
  if (![3, 5].includes(args.length) || !['init', 'remove'].includes(action) || flag !== '--host' || !Object.hasOwn(locations, host)
      || (args.length === 5 && (scopeFlag !== '--scope' || !['user', 'project'].includes(scope)))) {
    throw new Error(usage);
  }
  if (process.platform === 'win32') throw new Error('The Python hook requires POSIX (Linux/macOS).');
  if (action === 'init') {
    const python = spawnSync('python3', ['-I', '-c', 'import sys; sys.exit(sys.version_info < (3,10))'], { timeout: 10000 });
    if (python.status !== 0) throw new Error('Python 3.10+ must be available as python3.');
  }
  if (scope === 'user') {
    if (action === 'init' && refersToRuntime(settings(locations[host][0]))) {
      throw new Error(`Project hooks already reference Intent Loop. Run: intent-loop remove --host ${host} --scope project, then retry. Inspect modified/shared hooks before removing them.`);
    }
    installUserPlugin({ pkg, host, action });
    return;
  }
  const [configPath, skillPath] = locations[host];
  const config = settings(configPath);
  const originalConfig = JSON.stringify(config);
  if (action === 'remove' && !events.some(event => config.hooks?.[event]?.some(owned))) {
    console.log(`No unmodified Intent Loop registration for ${host}; files left untouched.`);
    return;
  }
  const payloads = new Map([
    [runtime, fs.readFileSync(path.join(pkg, 'scripts/review_gate.py'))],
    [skillPath, fs.readFileSync(path.join(pkg, 'skills/intent-loop/SKILL.md'))],
  ]);
  const changes = new Map(), kept = [];
  if (action === 'init') {
    for (const [name, bytes] of payloads) {
      const existing = read(name);
      if (existing && !existing.equals(bytes)) throw new Error(`Existing different file; not overwritten: ${name}`);
      changes.set(name, bytes);
    }
    config.hooks ??= {};
    for (const event of events) {
      const groups = config.hooks[event] ??= [];
      if (groups.some(g => g.hooks.some(h => h.command === command) && !owned(g))) {
        throw new Error(`Modified Intent Loop registration in ${event}; inspect it before installing.`);
      }
      if (!groups.some(owned)) groups.push(structuredClone(registration));
    }
  } else {
    for (const event of events) {
      if (!config.hooks?.[event]) continue;
      config.hooks[event] = config.hooks[event].filter(g => !owned(g));
      if (!config.hooks[event].length) delete config.hooks[event];
    }
    if (config.hooks && !Object.keys(config.hooks).length) delete config.hooks;
    const other = host === 'codex' ? 'claude' : 'codex';
    const otherSettings = settings(locations[other][0]);
    for (const [name, bytes] of payloads) {
      if (refersToRuntime(config) || (name === runtime && refersToRuntime(otherSettings))) {
        kept.push(name); continue;
      }
      const existing = read(name);
      if (existing && existing.equals(bytes)) changes.set(name, null);
      else if (existing) kept.push(name);
    }
  }
  if (JSON.stringify(config) !== originalConfig) changes.set(configPath, Buffer.from(JSON.stringify(config, null, 2) + '\n'));
  apply(changes);
  if (action === 'remove') {
    for (const dir of [path.dirname(skillPath), '.intent-loop']) {
      try { fs.rmdirSync(checkPath(dir)); } catch { /* Do not remove user content. */ }
    }
  }
  console.log(`${action === 'init' ? 'Installed' : 'Removed'} Intent Loop for ${host} in ${root}.`);
  if (kept.length) console.log(`Retained shared, modified, or referenced files: ${kept.join(', ')}`);
  if (action === 'init') {
    console.log('Keep .intent-review/ out of Git; it contains session messages and constraints.');
    console.log(host === 'codex' ? 'Review/trust the hooks with /hooks, then use a new session.' : 'Use a new Claude Code session to load the project hooks and skill.');
  }
}

try { main(); } catch (error) { console.error(`intent-loop: ${error.message}`); process.exitCode = 1; }

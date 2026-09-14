import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkg = process.env.INTENT_LOOP_TEST_PACKAGE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(pkg, 'bin/intent-loop.mjs');
const events = ['UserPromptSubmit', 'PreToolUse', 'SessionStart', 'Stop'];
const hostBin = fs.mkdtempSync(path.join(os.tmpdir(), 'intent-host-list-'));
after(() => fs.rmSync(hostBin, {recursive:true, force:true}));
for (const host of ['codex','claude']) {
  fs.writeFileSync(path.join(hostBin,host), `#!${process.execPath}\nprocess.stdout.write(process.env.PLUGIN_LIST || ${JSON.stringify(host === 'codex' ? '{"installed":[]}' : '[]')});`, {mode:0o755});
}


function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "intent space's-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(root, action = 'init', host = 'codex', extra = {}) {
  return spawnSync(process.execPath, [cli, action, '--host', host, '--scope', 'project'], { cwd: root, encoding: 'utf8', env: {...process.env, PATH:hostBin+path.delimiter+process.env.PATH, ...extra} });
}
function write(root, name, content) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function config(root, host = 'codex') {
  return JSON.parse(fs.readFileSync(path.join(root, host === 'codex' ? '.codex/hooks.json' : '.claude/settings.json')));
}
function ok(result) { assert.equal(result.status, 0, result.stderr); }

test('installs, preserves unrelated settings, and repeated init makes no changes', t => {
  const root = workspace(t);
  const other = { hooks: [{ type: 'command', command: 'echo other' }] };
  write(root, '.codex/hooks.json', JSON.stringify({ description: 'existing', hooks: { Stop: [other] } }));
  ok(run(root));
  assert.equal(config(root).description, 'existing');
  assert.deepEqual(config(root).hooks.Stop[0], other);
  for (const event of events) assert.ok(config(root).hooks[event].length);
  assert.ok(fs.existsSync(path.join(root, '.agents/skills/intent-loop/SKILL.md')));
  const before = fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8');
  ok(run(root));
  assert.equal(fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8'), before);
});

test('two hosts share runtime and removing one preserves the other and session data', t => {
  const root = workspace(t);
  ok(run(root)); ok(run(root, 'init', 'claude'));
  write(root, '.intent-review/keep.json', '{"private":"session data"}');
  ok(run(root, 'remove'));
  assert.ok(fs.existsSync(path.join(root, '.intent-loop/review_gate.py')));
  assert.ok(config(root, 'claude').hooks.PreToolUse.length);
  ok(run(root, 'remove', 'claude'));
  assert.equal(fs.existsSync(path.join(root, '.intent-loop/review_gate.py')), false);
  assert.equal(fs.readFileSync(path.join(root, '.intent-review/keep.json'), 'utf8'), '{"private":"session data"}');
  ok(run(root, 'remove', 'claude'));
});

test('invalid JSON or existing different runtime never gets overwritten', t => {
  const root = workspace(t);
  write(root, '.codex/hooks.json', '{invalid');
  assert.notEqual(run(root).status, 0);
  assert.equal(fs.readFileSync(path.join(root, '.codex/hooks.json'), 'utf8'), '{invalid');
  assert.equal(fs.existsSync(path.join(root, '.intent-loop/review_gate.py')), false);
  fs.unlinkSync(path.join(root, '.codex/hooks.json'));
  write(root, '.intent-loop/review_gate.py', 'user code');
  assert.notEqual(run(root).status, 0);
  assert.equal(fs.readFileSync(path.join(root, '.intent-loop/review_gate.py'), 'utf8'), 'user code');
  assert.equal(fs.existsSync(path.join(root, '.codex/hooks.json')), false);
});

test('removal retains modified files and unrelated hook registrations', t => {
  const root = workspace(t);
  ok(run(root));
  write(root, '.agents/skills/intent-loop/SKILL.md', 'user changes');
  const settings = config(root);
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo keep' }] });
  write(root, '.codex/hooks.json', JSON.stringify(settings));
  ok(run(root, 'remove'));
  assert.equal(fs.readFileSync(path.join(root, '.agents/skills/intent-loop/SKILL.md'), 'utf8'), 'user changes');
  assert.deepEqual(config(root).hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo keep' }] }]);
});

test('symlink destination is rejected without changing its target', t => {
  const root = workspace(t), outside = workspace(t);
  fs.symlinkSync(outside, path.join(root, '.codex'), 'dir');
  assert.notEqual(run(root).status, 0);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('write failure rolls back earlier writes', { skip: process.getuid?.() === 0 }, t => {
  const root = workspace(t);
  write(root, '.claude/settings.json', '{"keep":true}');
  fs.mkdirSync(path.join(root, '.claude/skills'), { recursive: true });
  fs.chmodSync(path.join(root, '.claude/skills'), 0o500);
  try {
    assert.notEqual(run(root, 'init', 'claude').status, 0);
    assert.equal(fs.existsSync(path.join(root, '.intent-loop/review_gate.py')), false);
    assert.equal(fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf8'), '{"keep":true}');
  } finally { fs.chmodSync(path.join(root, '.claude/skills'), 0o700); }
});

test('installed hooks execute in a path containing spaces and apostrophes', t => {
  const root = workspace(t);
  ok(run(root));
  const hooks = config(root).hooks;
  function call(name, extra = {}) {
    const event = { hook_event_name: name, cwd: root, session_id: 'installed-test', ...extra };
    const result = spawnSync('/bin/sh', ['-c', hooks[name][0].hooks[0].command], {
      cwd: root, encoding: 'utf8', input: JSON.stringify(event),
    });
    ok(result);
    return result.stdout ? JSON.parse(result.stdout) : null;
  }
  const prompt = call('UserPromptSubmit', { prompt: 'Do not delete inputs.' });
  const text = prompt.hookSpecificOutput.additionalContext;
  assert.equal(call('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'touch work' } }).hookSpecificOutput.permissionDecision, 'deny');
  const command = text.split('Command: ')[1].split('\n')[0];
  assert.equal(call('PreToolUse', { tool_name: 'Bash', tool_input: { command } }), null);
  ok(spawnSync('/bin/sh', ['-c', command], { cwd: root, encoding: 'utf8' }));
  assert.equal(call('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'touch work' } }), null);
  assert.match(call('SessionStart', { source: 'compact' }).hookSpecificOutput.additionalContext, /reviewed/);
});

test('invalid arguments do not install anything', t => {
  const root = workspace(t);
  assert.notEqual(run(root, 'init', 'unknown').status, 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('existing settings permissions remain private', t => {
  const root = workspace(t);
  write(root, '.claude/settings.json', '{"keep":true}');
  const target = path.join(root, '.claude/settings.json');
  fs.chmodSync(target, 0o600);
  ok(run(root, 'init', 'claude'));
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  ok(run(root, 'remove', 'claude'));
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('remove without an owned registration does not claim matching files', t => {
  const root = workspace(t);
  const source = fs.readFileSync(path.join(pkg, 'scripts/review_gate.py'));
  write(root, '.intent-loop/review_gate.py', source);
  ok(run(root, 'remove'));
  assert.deepEqual(fs.readFileSync(path.join(root, '.intent-loop/review_gate.py')), source);
});

test('project init refuses active global plugins before writing, but removal still works', t => {
  for (const host of ['codex','claude']) {
    const root=workspace(t);
    const entry=host==='codex' ? {pluginId:'intent-loop@custom',enabled:true} : {id:'intent-loop@custom',scope:'user',enabled:true};
    const extra={PLUGIN_LIST:JSON.stringify(host==='codex'?{installed:[entry]}:[entry])};
    const result=run(root,'init',host,extra);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/global.*Intent Loop/i);
    assert.deepEqual(fs.readdirSync(root),[]);
    ok(run(root,'remove',host,extra));
  }
});

test('project init rejects unreadable inventory and allows disabled global plugin', t => {
  const root=workspace(t);
  assert.notEqual(run(root,'init','codex',{PLUGIN_LIST:'{broken'}).status,0);
  assert.deepEqual(fs.readdirSync(root),[]);
  ok(run(root,'init','codex',{PLUGIN_LIST:JSON.stringify({installed:[{pluginId:'intent-loop@intent-loop',enabled:false}]})}));
});

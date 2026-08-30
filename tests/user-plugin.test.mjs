import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkg = process.env.INTENT_LOOP_TEST_PACKAGE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'))).version;
function setup(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "intent user's-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  for (const dir of ['bin', 'a', 'b']) fs.mkdirSync(path.join(base, dir));
  const preload = path.join(base, 'home.mjs');
  fs.writeFileSync(preload, `import os from 'node:os'; os.homedir = () => ${JSON.stringify(base)};`);
  for (const host of ['codex', 'claude']) {
    fs.writeFileSync(path.join(base, 'bin', host), `#!${process.execPath}\nconst fs=require('node:fs'); fs.appendFileSync(process.env.CALL_LOG,JSON.stringify(process.argv.slice(2))+'\\n'); if(process.env.FAIL_INSTALL && process.argv[2]==='plugin' && ['add','install'].includes(process.argv[3])) process.exit(9);\n`, { mode: 0o755 });
  }
  const log = path.join(base, 'calls');
  const env = { ...process.env, PATH: path.join(base, 'bin') + path.delimiter + process.env.PATH, CALL_LOG: log };
  const run = (host='codex', action='init', cwd='a', extra={}) => spawnSync(process.execPath,
    ['--import', preload, path.join(pkg, 'bin/intent-loop.mjs'), action, '--host', host],
    { cwd: path.join(base, cwd), env: { ...env, ...extra }, encoding: 'utf8' });
  return { base, run, log, root: path.join(base, '.local/share/intent-loop', version) };
}
test('default installs through native user plugin commands from any directory', t => {
  const { base, run, root, log } = setup(t);
  for (const host of ['codex', 'claude']) {
    const p=run(host); assert.equal(p.status,0,p.stderr);
    assert.equal(run(host,'init','b').status,0);
  }
  assert.deepEqual(fs.readdirSync(path.join(base,'a')),[]);
  assert.deepEqual(fs.readdirSync(path.join(base,'b')),[]);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(x=>JSON.stringify(x)===JSON.stringify(['plugin','add','intent-loop@intent-loop'])));
  assert.ok(calls.some(x=>JSON.stringify(x)===JSON.stringify(['plugin','install','intent-loop@intent-loop','--scope','user'])));
  assert.equal(fs.readFileSync(path.join(root,'scripts/review_gate.py'),'utf8'),fs.readFileSync(path.join(pkg,'scripts/review_gate.py'),'utf8'));
  assert.ok(!calls.flat().some(x=>x.includes('bypass')));
});
test('staging preserves modified files and rejects symlink destinations', t => {
  const { run, root }=setup(t);
  assert.equal(run().status,0);
  const target=path.join(root,'scripts/review_gate.py');
  fs.writeFileSync(target,'user changes');
  assert.notEqual(run().status,0);
  assert.equal(fs.readFileSync(target,'utf8'),'user changes');
  fs.unlinkSync(target); fs.symlinkSync(path.join(pkg,'scripts/review_gate.py'),target);
  assert.notEqual(run().status,0);
});
test('native install failure reports incomplete installation and allows retry', t => {
  const { run }=setup(t);
  const result=run('codex','init','a',{FAIL_INSTALL:'1'});
  assert.notEqual(result.status,0); assert.match(result.stderr,/retained/);
  assert.doesNotMatch(result.stdout,/Installed user-wide/);
  assert.equal(run().status,0);
});
test('global removal delegates to host and retains source and session data', t => {
  const { run, base, root, log }=setup(t);
  assert.equal(run().status,0);
  fs.mkdirSync(path.join(base,'a','.intent-review'));
  fs.writeFileSync(path.join(base,'a','.intent-review','keep.json'),'keep');
  assert.equal(run('codex','remove').status,0);
  assert.equal(run('claude','remove').status,0);
  assert.ok(fs.existsSync(path.join(root,'scripts/review_gate.py')));
  assert.equal(fs.readFileSync(path.join(base,'a','.intent-review','keep.json'),'utf8'),'keep');
  assert.match(fs.readFileSync(log,'utf8'),/uninstall.*--scope.*user/);
});
test('default refuses a duplicate project hook installation', t => {
  const {run,base}=setup(t);
  fs.mkdirSync(path.join(base,'a','.codex'));
  fs.writeFileSync(path.join(base,'a','.codex/hooks.json'),JSON.stringify({hooks:{Stop:[{hooks:[{command:'python3 review_gate.py hook'}]}]}}));
  const result=run(); assert.notEqual(result.status,0); assert.match(result.stderr,/--scope project/);
});

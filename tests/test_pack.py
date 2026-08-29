"""Exercise the packaged hook configuration after relocation."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest


class PackTest(unittest.TestCase):
    def test_relocated_hook_blocks_then_accepts_submission(self):
        source = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            pack = Path(tmp) / 'pack with spaces'
            shutil.copytree(source, pack, ignore=shutil.ignore_patterns('__pycache__'))
            work = Path(tmp) / 'work'
            work.mkdir()
            hooks = json.loads((pack/'hooks/hooks.json').read_text())['hooks']
            env = {**os.environ, 'CLAUDE_PLUGIN_ROOT': str(pack)}

            def event(name, **extra):
                command = hooks[name][0]['hooks'][0]['command']
                payload = dict(hook_event_name=name, cwd=str(work), session_id='pack-test', **extra)
                result = subprocess.run(['/bin/sh', '-c', command], env=env, cwd=work,
                                        input=json.dumps(payload), capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout) if result.stdout else None

            output = event('UserPromptSubmit', prompt='Do not delete original files.')
            context = output['hookSpecificOutput']['additionalContext']
            self.assertIn('pending', context)
            blocked = event('PreToolUse', tool_name='Bash', tool_input={'command':'touch artifact'})
            self.assertEqual(blocked['hookSpecificOutput']['permissionDecision'], 'deny')
            command = context.split('Command: ',1)[1].split('\n',1)[0]
            self.assertIsNone(event('PreToolUse', tool_name='Bash', tool_input={'command':command}))
            result = subprocess.run(shlex.split(command), cwd=work, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIsNone(event('PreToolUse', tool_name='Bash', tool_input={'command':'touch artifact'}))
            restored = event('SessionStart', source='compact')
            self.assertIn('reviewed', restored['hookSpecificOutput']['additionalContext'])


if __name__ == '__main__':
    unittest.main()

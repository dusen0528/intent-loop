"""Real process/JSON contract tests for mandatory constraint review."""
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

GATE = (Path(__file__).resolve().parents[1] / 'scripts' / 'review_gate.py')


class ReviewGateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def hook(self, name, session='s1', **kw):
        event = dict(hook_event_name=name, session_id=session, cwd=str(self.root), **kw)
        result = subprocess.run([sys.executable, str(GATE), 'hook'], input=json.dumps(event),
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def begin(self, prompt='Do not delete files.'):
        output = self.hook('UserPromptSubmit', prompt=prompt)
        self.assertIn('review_id', output)
        return json.loads(output)['hookSpecificOutput']['additionalContext']

    def state(self):
        paths = list((self.root/'.intent-review').glob('*.json'))
        self.assertEqual(len(paths), 1)
        return paths[0], json.loads(paths[0].read_text())

    def command(self, changes=None, token=None):
        path, state = self.state()
        return shlex.join([sys.executable, '-I', str(GATE), 'submit', str(path),
                           token or state['review_id'], json.dumps(changes or [])])

    def submit(self, changes=None, token=None):
        return subprocess.run(shlex.split(self.command(changes, token)), text=True, capture_output=True)

    def blocked(self, tool='Bash', **kw):
        output = self.hook('PreToolUse', tool_name=tool, tool_input=kw or {'command':'touch work'})
        return bool(output) and json.loads(output)['hookSpecificOutput']['permissionDecision']=='deny'

    def test_missing_review_blocks_work(self):
        self.begin()
        self.assertTrue(self.blocked())

    def test_submission_path_is_exempt_but_chained_shell_is_not(self):
        self.begin()
        command = self.command()
        self.assertFalse(self.blocked(command=command))
        self.assertTrue(self.blocked(command=command+'; touch work'))
        self.assertTrue(self.blocked(command=command+' && touch work'))
        self.assertTrue(self.blocked(command='echo '+command))
        self.assertTrue(self.blocked(command=command, cwd='/tmp'))
        self.assertFalse(self.blocked('AskUserQuestion'))

    def test_no_changes_unlocks_only_current_turn(self):
        self.begin()
        self.assertEqual(self.submit().returncode, 0)
        self.assertFalse(self.blocked())
        # Identical text is still a new user message.
        self.begin()
        self.assertTrue(self.blocked())

    def test_stale_review_cannot_unlock_new_prompt(self):
        self.begin()
        old = self.state()[1]['review_id']
        self.begin('Now allow deletion.')
        self.assertNotEqual(self.submit(token=old).returncode, 0)
        self.assertTrue(self.blocked())

    def test_two_unreviewed_messages_are_both_preserved(self):
        self.begin('Do not delete files.')
        self.begin('Also avoid new dependencies.')
        changes=[dict(op='add',id='c1',text='No deletes',source_quote='Do not delete files.'),
                 dict(op='add',id='c2',text='No new dependencies',source_quote='avoid new dependencies')]
        self.assertEqual(self.submit(changes).returncode, 0)
        self.assertEqual(set(self.state()[1]['constraints']), {'c1','c2'})

    def test_same_codex_turn_event_is_idempotent(self):
        self.hook('UserPromptSubmit', prompt='No deletes', turn_id='turn-1')
        self.assertEqual(self.submit().returncode, 0)
        self.hook('UserPromptSubmit', prompt='No deletes', turn_id='turn-1')
        self.assertFalse(self.blocked())

    def test_shell_expansion_cannot_use_submission_exemption(self):
        self.begin()
        path, state=self.state()
        prefix=shlex.join([sys.executable,'-I',str(GATE),'submit',str(path),state['review_id']])
        self.assertTrue(self.blocked(command=prefix+' "$(touch OWNED)"'))

    def test_add_replace_remove_and_restore(self):
        self.begin()
        add=[dict(op='add', id='c1', text='Do not delete files.', source_quote='Do not delete files.')]
        self.assertEqual(self.submit(add).returncode, 0)
        output=self.hook('SessionStart', source='compact')
        self.assertIn('Do not delete files.', output)
        self.begin('Only temporary files may be deleted.')
        replace=[dict(op='replace', id='c1', text='Only temporary files may be deleted.',
                      source_quote='Only temporary files may be deleted.')]
        self.assertEqual(self.submit(replace).returncode, 0)
        self.begin('Remove the deletion restriction.')
        remove=[dict(op='remove', id='c1', source_quote='Remove the deletion restriction.')]
        self.assertEqual(self.submit(remove).returncode, 0)
        self.assertEqual(self.state()[1]['constraints'], {})

    def test_compaction_does_not_clear_pending_review(self):
        self.begin()
        output=self.hook('SessionStart', source='compact')
        self.assertIn('pending', output)
        self.assertTrue(self.blocked())

    def test_invalid_change_is_atomic_and_keeps_gate_closed(self):
        self.begin()
        changes=[dict(op='add',id='c1',text='No deletes',source_quote='Do not delete files.'),
                 dict(op='remove',id='missing',source_quote='Do not delete files.')]
        self.assertNotEqual(self.submit(changes).returncode, 0)
        self.assertEqual(self.state()[1]['constraints'], {})
        self.assertTrue(self.blocked())

    def test_invented_quote_is_rejected(self):
        self.begin()
        changes=[dict(op='add',id='c1',text='Delete everything',source_quote='Approved!')]
        self.assertNotEqual(self.submit(changes).returncode, 0)
        self.assertTrue(self.blocked())

    def test_other_session_does_not_restore_constraints(self):
        self.begin()
        self.assertEqual(self.hook('SessionStart', session='s2', source='compact'), '')

    def test_missing_and_corrupt_state_fail_closed_for_work(self):
        self.assertTrue(self.blocked())
        self.begin()
        self.state()[0].write_text('{broken')
        self.assertTrue(self.blocked())

    def test_stop_blocks_pending_once_then_reports_incomplete(self):
        self.begin()
        self.assertEqual(json.loads(self.hook('Stop'))['decision'], 'block')
        self.assertNotIn('"decision": "block"', self.hook('Stop', stop_hook_active=True))
        self.assertTrue(self.blocked())


if __name__ == '__main__':
    unittest.main()

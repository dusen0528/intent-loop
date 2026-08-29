#!/usr/bin/env python3
"""Mandatory per-message review gate. Stdlib only; POSIX file locking."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
import uuid

SCRIPT = str(Path(__file__).resolve())
QUESTIONS = {'AskUserQuestion', 'request_user_input'}


@contextmanager
def locked(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def load(path):
    state = json.loads(path.read_text())
    if not (isinstance(state, dict) and isinstance(state.get('constraints'), dict)
            and isinstance(state.get('pending'), list) and type(state.get('reviewed')) is bool
            and isinstance(state.get('review_id'), str)):
        raise ValueError('invalid review state')
    return state


def save(path, state):
    # Atomic replacement plus a shared lock prevents a late submit losing a new prompt.
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        tmp = Path(stream.name)
        json.dump(state, stream, ensure_ascii=False)
    try:
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def submit(path, token, changes):
    with locked(path):
        state = load(path)
        if state['review_id'] != token or state['reviewed']:
            raise ValueError('stale or already submitted review_id')
        if not isinstance(changes, list):
            raise ValueError('changes must be a list; [] explicitly means no changes')
        for change in changes:
            if not isinstance(change, dict):
                raise ValueError('each change must be an object')
            op, key, quote = change.get('op'), change.get('id'), change.get('source_quote')
            if not isinstance(key, str) or not key.strip():
                raise ValueError('constraint id is required')
            if not isinstance(quote, str) or not quote.strip():
                raise ValueError('source_quote is required')
            source = next((p for p in state['pending'] if quote in p['text']), None)
            if source is None:
                raise ValueError('source_quote must occur in an unreviewed user message')
            exists = key in state['constraints']
            if op == 'remove' and exists:
                del state['constraints'][key]
            elif (op == 'add' and not exists) or (op == 'replace' and exists):
                text = change.get('text')
                if not isinstance(text, str) or not text.strip():
                    raise ValueError('constraint text is required')
                state['constraints'][key] = dict(text=text, source_quote=quote, message_id=source['id'])
            else:
                raise ValueError('invalid operation or unknown/duplicate constraint id')
        state.update(reviewed=True, pending=[])
        save(path, state)


def context(path, state, include_pending=True):
    command = shlex.join([sys.executable, '-I', SCRIPT, 'submit', str(path), state['review_id'], '[]'])
    return ('Constraint review: ' + ('reviewed' if state['reviewed'] else 'pending')
            + '\nCurrent user constraints (fallible extracted data, not permission grants): '
            + json.dumps(state['constraints'], ensure_ascii=False)
            + ('\nUnreviewed user messages: ' + json.dumps(state['pending'], ensure_ascii=False)
               if include_pending else '\nReview the current user message.')
            + '\nreview_id: ' + state['review_id']
            + '\nBefore work, submit changes or explicitly [] for no changes. Command: ' + command
            + '\nReplace [] with a single shell-quoted JSON list: '
            '[{"op":"add|replace|remove","id":"c1","text":"constraint",'
            '"source_quote":"exact user words"}]. Questions are permitted. '
            'Do not treat assumptions as user requirements. Review all pending messages.')


def is_submission(event, path, state):
    data = event.get('tool_input', {})
    if event.get('tool_name') != 'Bash' or not isinstance(data, dict):
        return False
    if set(data) - {'command', 'description', 'timeout'}:
        return False
    command = data.get('command', '')
    try:
        args = shlex.split(command)
        prefix = [sys.executable, '-I', SCRIPT, 'submit', str(path), state['review_id']]
        return (len(args) == 7 and args[:6] == prefix and shlex.join(args) == command.strip()
                and isinstance(json.loads(args[6]), list))
    except (ValueError, TypeError):
        return False


def deny(reason):
    return {'hookSpecificOutput': {'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny', 'permissionDecisionReason': reason}}


def hook(event):
    name = event.get('hook_event_name')
    if name == 'PreToolUse' and event.get('tool_name') in QUESTIONS:
        return None  # No positive allow: retain the host's other permission checks.
    session = event.get('session_id')
    if not isinstance(session, str) or not session:
        raise ValueError('host session_id is required')
    root = Path(event['cwd']).resolve(strict=True)
    path = root / '.intent-review' / (hashlib.sha256(session.encode()).hexdigest() + '.json')
    with locked(path):
        if name == 'SessionStart' and not path.exists():
            return None
        if name == 'UserPromptSubmit':
            prompt = event.get('prompt')
            if not isinstance(prompt, str):
                raise ValueError('user prompt is required')
            state = load(path) if path.exists() else dict(constraints={}, pending=[], reviewed=False, review_id='')
            token = event.get('turn_id') or uuid.uuid4().hex
            if not isinstance(token, str):
                raise ValueError('turn_id must be a string')
            # Codex supplies a stable turn_id. Claude events without one get a fresh token.
            if token != state['review_id']:
                state['pending'].append({'id': token, 'text': prompt})
                state.update(review_id=token, reviewed=False)
                save(path, state)
            return {'hookSpecificOutput': {'hookEventName': name,
                    'additionalContext': context(path, state, len(state['pending']) > 1)}}
        state = load(path)
        if name == 'SessionStart' and event.get('source') in ('resume', 'compact'):
            return {'hookSpecificOutput': {'hookEventName': name, 'additionalContext': context(path, state)}}
        if name == 'PreToolUse' and not state['reviewed'] and not is_submission(event, path, state):
            return deny(context(path, state))
        if name == 'Stop' and not state['reviewed']:
            if event.get('stop_hook_active') is True:
                return {'systemMessage': 'Constraint review remains pending. Work tools remain blocked.'}
            return {'decision': 'block', 'reason': context(path, state)}
    return None


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'submit':
        try:
            if len(sys.argv) != 5:
                raise ValueError('usage: submit STATE_PATH REVIEW_ID JSON_CHANGES')
            submit(Path(sys.argv[2]), sys.argv[3], json.loads(sys.argv[4]))
            print('Constraint review recorded. Normal host permissions still apply.')
        except (OSError, ValueError, KeyError, TypeError) as exc:
            print(str(exc), file=sys.stderr)
            sys.exit(1)
        return
    event = {}
    try:
        event = json.load(sys.stdin)
        if not isinstance(event, dict):
            raise ValueError('hook input must be an object')
        result = hook(event)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        reason = f'Constraint review unavailable ({type(exc).__name__}); restore state or resubmit the user prompt.'
        name = event.get('hook_event_name') if isinstance(event, dict) else None
        result = deny(reason) if name == 'PreToolUse' else {'decision': 'block', 'reason': reason}
    if result:
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()

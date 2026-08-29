#!/usr/bin/env python3
"""Inspect an npm tarball without extracting or executing it. Stdlib only."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import tarfile

REQUIRED = {
    'package/package.json', 'package/README.md', 'package/bin/intent-loop.mjs',
    'package/scripts/review_gate.py', 'package/skills/intent-loop/SKILL.md',
    'package/hooks/hooks.json', 'package/.codex-plugin/plugin.json',
    'package/.claude-plugin/plugin.json',
}
OPTIONAL = {'package/LICENSE'}
SECRET = re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|'
                    rb'npm_[A-Za-z0-9]{36,}|gh[pousr]_[A-Za-z0-9]{30,}|'
                    rb'github_pat_[A-Za-z0-9_]{40,}')


def check(archive, ready=False, source=None):
    files = {}
    with tarfile.open(archive, 'r:gz') as tar:
        for item in tar:
            if not item.isfile() or item.name not in REQUIRED | OPTIONAL or item.name in files:
                raise ValueError(f'unexpected or non-regular package entry: {item.name}')
            data = tar.extractfile(item).read()
            if SECRET.search(data):
                raise ValueError(f'possible credential in {item.name}; inspect locally')
            if source is not None and data != (source / item.name.removeprefix('package/')).read_bytes():
                raise ValueError(f'package differs from reviewed source: {item.name}')
            files[item.name] = data
    if REQUIRED - files.keys():
        raise ValueError(f'missing package files: {sorted(REQUIRED - files.keys())}')
    manifest = json.loads(files['package/package.json'])
    for key in ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies'):
        if manifest.get(key):
            raise ValueError(f'external dependencies require review: {key}')
    if set(manifest.get('scripts', {})) - {'test'}:
        raise ValueError('unexpected lifecycle or package script')
    if manifest.get('bin') != {'intent-loop': 'bin/intent-loop.mjs'}:
        raise ValueError('unexpected CLI entry point')
    for name in ('package/.codex-plugin/plugin.json', 'package/.claude-plugin/plugin.json'):
        if json.loads(files[name])['version'] != manifest['version']:
            raise ValueError('plugin/package versions differ')
    if ready:
        if manifest.get('private') or not re.fullmatch(r'@[^/]+/intent-loop', manifest['name']):
            raise ValueError('public scoped package identity is not ready')
        if manifest.get('license') != 'UNLICENSED' or 'package/LICENSE' in files:
            raise ValueError('license decision is deferred; preserve UNLICENSED for this release')
        if manifest.get('publishConfig') != {'access':'public', 'registry':'https://registry.npmjs.org/'}:
            raise ValueError('explicit npmjs public publishing configuration is required')
    data = archive.read_bytes()
    return dict(name=manifest['name'], version=manifest['version'], files=sorted(files),
                sha256=hashlib.sha256(data).hexdigest(),
                integrity='sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode(),
                checks='allowlist, regular files, dependency/script policy, credential patterns, versions',
                ready=ready)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--ready', action='store_true')
    args=parser.parse_args()
    try:
        print(json.dumps(check(args.archive, args.ready, args.source), indent=2))
    except (ValueError, OSError, KeyError, tarfile.TarError) as error:
        parser.exit(1, f'Release check failed: {error}\n')

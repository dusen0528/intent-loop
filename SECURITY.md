# Security

Intent Loop is a local workflow guardrail, not a sandbox or authorization system.

## Package controls

- No npm or Python third-party dependencies.
- No install/postinstall/prepare hooks, downloaded executables, or telemetry.
- Project configuration changes happen only through an explicit `init` command.
- Destination symlinks and conflicting files are rejected. Existing configuration permissions are preserved.
- `.intent-review/` stores session text locally and is excluded from the release package. Keep it out of project Git history.

The npm `files` allowlist is checked against the actual tarball by `scripts/check_release.py`. It rejects unexpected files, links, dependencies, package scripts, mismatched versions, and common credential formats. Pattern checks are not a complete secret audit.

## Release procedure

1. Run `npm test` and pack with `npm pack --ignore-scripts`.
2. Run `python3 scripts/check_release.py PACKAGE.tgz --source . --ready`.
3. Test the extracted tarball and record its SHA-512 integrity.
4. Publish that same tarball using an authenticated maintainer session with 2FA, without bypass tokens: `npm publish PACKAGE.tgz --ignore-scripts --access public --registry=https://registry.npmjs.org/`.
5. Compare the registry's `dist.integrity` with the checked artifact and install the exact released version in a disposable project.

For CI publishing, prefer npm Trusted Publishing (OIDC), immutable action commit references, restricted release permissions, and an approved release environment. These controls are not enabled merely by including this document. npm provenance also requires a public source repository; do not claim provenance for a local publish.

Pin an exact package version when installing. A version pin limits unexpected upgrades but does not make malicious code safe. Review updates before replacing an installed hook.

## Boundaries

The model interprets constraints. A submitted review is not proof of correct interpretation, and stored policy text is not an approval token. Hooks cover only tool paths the host exposes; existing processes and some hosted tools are outside their scope. State and scripts remain writable by a user or agent with matching filesystem access.

Do not run the installer concurrently in the same project. Stop active sessions before removing or replacing their hook installation.

## Reporting

Contact the repository maintainer privately for a vulnerability involving sensitive data. Do not post session transcripts, credentials, or exploit details in a public issue. No dedicated private advisory channel is configured yet.

References: [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) and [npm package provenance](https://docs.npmjs.com/generating-provenance-statements/).

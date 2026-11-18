# galaxie coding-agent skill

This skill describes host-owned routing, capability policy, confirmations, supported
framework shapes and verification for apps using galaxie. Generated projects already
carry the matching skill in `.agents/skills/galaxie` and `.claude/skills/galaxie`.
Both directories contain real files. Read [SKILL.md](SKILL.md) for the rules.

## Install into an existing app

The installer is prepared for 0.2.0, but `v0.2.0` does not exist until the maintainer creates it. Nothing here publishes a package or
creates a release. Once a matching release exists, check out its `v<version>` tag
and run the local script with **Node >=22.18** (built-in TypeScript stripping):

```sh
git clone --branch v<version> --depth 1 https://github.com/vinhnxv/galaxie.git
cd galaxie
node scripts/install-skill.ts /path/to/app
```

Replace `<version>` with the exact app `@galaxie-ai/core` version. The script reads
the app's `node_modules/@galaxie-ai/core/package.json` by path. If absent, it uses
an exact dependency or devDependency from the app's `package.json`; ranges are
refused. For a hoisted monorepo whose app has no local core installation, supply
the verified installed version explicitly:

```sh
node scripts/install-skill.ts /path/to/app --core-version 0.2.0
```

An installed local version takes precedence over the override. An exact dependency
with no installed core is trusted as written; the installer prints a notice because
it cannot verify an installation. A mismatch or
unresolved version fails before any writes. The installer needs no dependencies,
package manager, network or provider credentials; cloning the future tag is a
separate network step.

Only `SKILL.md` and `references/*` are copied into both skill directories. This
README is not copied. The installer never opens the app's `AGENTS.md` or `CLAUDE.md`
for writing. It checks both destinations before writing and refuses symlinks in
their existing paths or contents. An identical reinstall succeeds without writes.
Different existing skill contents require explicit replacement:

```sh
node scripts/install-skill.ts /path/to/app --replace-skill
```

Replacement removes only `.agents/skills/galaxie` and `.claude/skills/galaxie` when
their contents differ. Other skills and app instruction files are preserved.
Do not edit the destination concurrently: filesystem checks do not isolate writes
from another process that can modify the app directory.

Exit codes: `0` installed or already identical; `1` version, filesystem or runtime
failure; `2` invalid arguments. Filesystem failures during copying can leave a
partial installation; fix the cause and rerun with `--replace-skill`.

## Evidence and limits

Node scratch-app tests compare instruction bytes before and after installation,
verify both copies against the source and cover mismatch, replacement and symlink
refusals without a network. The skill's version is checked against core in tests.
The [Next.js App Router guide](../../docs/guides/nextjs.md) and
[reference](references/nextjs.md) cover the workspace mock example in Chromium on
Next 16.4.6, with webpack production enforcement and report-only development.
The reference is copied with all common references; read it only for a Next host.
No agent has been measured consuming this skill. Release-tag installation, Windows,
Node below 22.18, installation into a Next app and real-agent use there remain
unmeasured. Package-manager installs
are irrelevant to this file-copy installer.

Maintainers refresh citations only after reviewing the changed rules:
`node scripts/check-docs.ts --refresh-citations`, then `pnpm run check:docs`.

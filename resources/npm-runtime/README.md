# Bundled npm runtime

Pideck keeps standalone Node.js and replaces the npm copy in that distribution
with npm 12.2.2. The original npm archive is obtained from the public npm
registry and checked against its pinned SHA-512 integrity before extraction.
Its CLI, library files, documentation, and license remain intact.

The adjacent production package metadata and lockfile rebuild npm's dependency
tree with standard `npm ci --ignore-scripts --omit=dev`. Glob is fixed at
14.0.4 and minimatch at 11.0.5, including transitive copies through overrides,
to avoid the affected versions shipped in npm's original bundled tree. The
remaining dependencies are locked with registry URLs and integrity values.
Development workspaces, development scripts, and the original bundling list
are omitted from this installed runtime metadata.

`scripts/npm-runtime.mjs` runs the installation from a separate verified npm
bootstrap, then copies the completed runtime into the target Node.js tree.
It does not patch JavaScript source or run dependency installation scripts.
Windows and Unix keep their normal Node.js npm/npx launchers.

`PIDECK-DEPENDENCIES.json` records every package in the actual installed npm
tree, including nested copies. `PIDECK-THIRD-PARTY-NOTICES.txt` contains their
license texts and attribution, including the version-specific supplements
documented in `licenses/README.md`. Preparation fails for a package without
license text. Final packaging verifies the inventory against the actual tree
and verifies the notice hash; npm's root license is not used as a substitute
for its dependencies' materials.

When updating this runtime, review the npm release, refresh the archive
integrity and production lock together, audit the actual installed package
tree, and exercise npm installation and npx through packaged Pideck. A root
project audit does not include this separate runtime.

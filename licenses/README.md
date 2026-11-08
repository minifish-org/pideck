# License supplements

`scripts/licenses.mjs` builds `dist/licenses/` from the installed runtime
dependencies and the dependency closure of renderer imports. It preserves
upstream license, copyright, NOTICE and embedded third-party license files,
including full license sections present only in a package README. It excludes
build-only tools and fails when a distributed package has no license text.

Some upstream npm tarballs declare a license but omit its text. The reviewed,
version-specific entries in `supplements.json` supply that missing material
without network access during builds. A dependency update does not inherit an
old supplement automatically. The text files in this directory are copied
verbatim from the recorded upstream sources:

- **Pi 1.5.0:** the MIT license from release commit
  [`f9a26365568127461c47a07a37dcb42c140a3ac5`](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/LICENSE).
  This supplies the repository-root license omitted by the chord, pi-ai,
  pi-durable, pi-codemode, pi-telemetry and pi-schema npm packages. The schema
  package's separate TypeBox license is also collected from its installed
  `LICENSES` directory.
- **Standard Webhooks 1.1.1:** the libraries' MIT license from npm's recorded
  `gitHead`,
  [`b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE`](https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE).
  The repository root has a different license; the library-specific license
  is used here.
- **AWS SDK:** the repository Apache-2.0 license from release commit
  [`80cb7896f530f5d7cb33b3c5abbdae1212dbd768`](https://github.com/aws/aws-sdk-js-v3/blob/80cb7896f530f5d7cb33b3c5abbdae1212dbd768/LICENSE).
  The package manifests at that commit match the reviewed HTTP credentials
  provider 3.972.83, login provider 3.972.88 and nested clients 3.998.0. Their npm
  tarballs omit the license file.
- **proxy-agent-negotiate 1.1.0:** the package declares MIT and Nathan Rajlich as
  its author but omits a license file. The supplement preserves the monorepo's
  MIT text and copyright notice from `proxy-agent/LICENSE` at its reviewed
  release commit
  [`b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16`](https://github.com/TooTallNate/proxy-agents/blob/b7e5f7ccce1a3ac5b339cc4c587974e8989cbc16/packages/proxy-agent/LICENSE).

esbuild platform packages receive the license from their installed esbuild
source package only when the versions and declared MIT license match.

The standalone npm tree is checked separately from the application dependency
closure. `PIDECK-DEPENDENCIES.json` inventories every physically installed npm
package, including nested copies; `PIDECK-THIRD-PARTY-NOTICES.txt` carries their
complete texts and attribution. Packaging compares the final installed tree
with that inventory and verifies the notice hash. New packages without license
text fail preparation; a declared SPDX identifier alone does not pass.

The npm-only supplements are:

- **@sigstore/verify 4.1.3:** the repository-root Apache-2.0 license at its npm
  `gitHead`, [`4576519f81b93bf96bd7457fc7252b8cfa11e67f`](https://github.com/sigstore/sigstore-js/blob/4576519f81b93bf96bd7457fc7252b8cfa11e67f/LICENSE).
- **@npmcli/agent 5.0.2:** the fixed upstream
  [`package.json`](https://github.com/npm/agent/blob/3fadae4d3ea4cc6c73003db2b42456afab9e3cdd/package.json)
  declares ISC and identifies GitHub Inc. as author, but that release's npm
  tarball and repository omit a license text. Its supplement preserves that
  declaration and attribution and includes the unmodified ISC standard text
  from SPDX license-list-data commit
  [`31846481de7ea17d92f2f46fad76abe58b2e9bb0`](https://github.com/spdx/license-list-data/blob/31846481de7ea17d92f2f46fad76abe58b2e9bb0/text/ISC.txt).
  The template's placeholders are preserved; no upstream copyright year or
  substituted owner is invented.
- **spdx-exceptions 2.5.0 and spdx-license-ids 3.0.24:** their fixed package
  manifests declare CC-BY-3.0 and CC0-1.0. The full standard texts come from
  that same SPDX commit. Their original README attribution/license sections
  are also preserved, including the Linux Foundation attribution. Exact
  declaration URLs are recorded in `supplements.json`.

All supplemental files have pinned SHA-256 hashes and are restricted to the
reviewed package version and declared license. Builds do not fetch legal
materials from the network. Standard license text supplements are identified
as such and are not described as files present in an upstream tarball.

`Pideck-LICENSE.txt` contains this project's AGPL license.
`THIRD_PARTY_NOTICES.txt` contains the collected texts, and `dependencies.json`
records package versions, provenance, and hashes of the distributed texts.
Packaging validates those files in the final ASAR rather than trusting only a
staging folder. Node.js/npm and Playwright retain their own complete upstream
notices in the separate automation distribution. Browser/media binaries are
downloaded directly from upstream on first use; they are not Pideck release
assets.

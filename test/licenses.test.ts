import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import asar from '@electron/asar';

type Inventory = { dependencies: { name: string; version: string }[] };
const { collectLicenses, prepareLicenses, validateLicenses, validatePackagedLicenses, prepareInstalledLicenses, validateInstalledLicenses } = await import(new URL('../scripts/licenses.mjs', import.meta.url).href) as {
  collectLicenses(root: string): Promise<Inventory['dependencies']>;
  prepareLicenses(root: string): Promise<Inventory>;
  validateLicenses(root: string): Promise<Inventory>;
  validatePackagedLicenses(archive: string): Promise<Inventory>;
  prepareInstalledLicenses(directory: string, root?: string): Promise<Inventory>;
  validateInstalledLicenses(directory: string): Promise<Inventory>;
};

async function fixture(run: (root: string, file: (path: string, text: string) => Promise<void>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pideck-licenses-'));
  const file = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  try {
    await file('package.json', JSON.stringify({ name: 'pideck', version: '0.1.0', license: 'AGPL-3.0-only', dependencies: { runtime: '1.0.0' }, devDependencies: { renderer: '1.0.0', 'build-only': '1.0.0' } }));
    await file('LICENSE', 'GNU AFFERO GENERAL PUBLIC LICENSE\nfixture application license');
    await file('src/renderer/main.ts', 'import "renderer/subpath";');
    await file('node_modules/runtime/package.json', JSON.stringify({ name: 'runtime', version: '1.0.0', license: 'MIT', dependencies: { shared: '1.0.0' } }));
    await file('node_modules/runtime/LICENSE', 'runtime license');
    await file('node_modules/runtime/NOTICE', 'runtime copyright notice');
    await file('node_modules/runtime/third_party/vendor/LICENSE.txt', 'embedded vendor license');
    await file('node_modules/runtime/third_party/vendor/binary.exe', 'BINARY MUST NOT ENTER NOTICES');
    await file('node_modules/shared/package.json', JSON.stringify({ name: 'shared', version: '1.0.0', license: 'MIT' }));
    await file('node_modules/shared/LICENSE', 'shared version one license');
    await file('node_modules/renderer/package.json', JSON.stringify({ name: 'renderer', version: '1.0.0', license: 'MIT', dependencies: { shared: '2.0.0' } }));
    await file('node_modules/renderer/LICENSE.md', 'renderer license');
    await file('node_modules/renderer/node_modules/shared/package.json', JSON.stringify({ name: 'shared', version: '2.0.0', license: 'MIT' }));
    await file('node_modules/renderer/node_modules/shared/license', 'shared version two license');
    await file('node_modules/build-only/package.json', JSON.stringify({ name: 'build-only', version: '1.0.0' }));
    await run(root, file);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('distributed notices include runtime and renderer dependency versions, notices and embedded licenses without build-only packages or binaries', async () => {
  await fixture(async root => {
    const inventory = await prepareLicenses(root);
    assert.deepEqual(inventory.dependencies.map(value => `${value.name}@${value.version}`).sort(), ['renderer@1.0.0', 'runtime@1.0.0', 'shared@1.0.0', 'shared@2.0.0']);
    const notices = await readFile(join(root, 'dist/licenses/THIRD_PARTY_NOTICES.txt'), 'utf8');
    for (const expected of ['runtime copyright notice', 'embedded vendor license', 'shared version one license', 'shared version two license']) assert.ok(notices.includes(expected));
    assert.ok(!notices.includes('BINARY MUST NOT ENTER NOTICES'));
    assert.ok(!(await readFile(join(root, 'dist/licenses/dependencies.json'), 'utf8')).includes(root));
    await validateLicenses(join(root, 'dist/licenses'));
  });
});

test('a declared SPDX license alone cannot silently pass the distribution check', async () => {
  await fixture(async root => {
    await rm(join(root, 'node_modules/renderer/LICENSE.md'));
    await assert.rejects(collectLicenses(root), /Missing distributed license text for renderer@1.0.0/);
  });
});

test('upstream license supplements are restricted to the reviewed package version and license', async () => {
  await fixture(async (root, file) => {
    await rm(join(root, 'node_modules/renderer/LICENSE.md'));
    const text = 'upstream renderer copyright and license';
    const sha256 = createHash('sha256').update(text).digest('hex');
    await file('licenses/supplements.json', JSON.stringify({ 'renderer@1.0.0': { license: 'MIT', file: 'renderer.txt', source: 'https://example.invalid/fixed-commit/LICENSE', sha256 } }));
    await file('licenses/renderer.txt', text);
    assert.ok((await collectLicenses(root)).some(value => value.name === 'renderer'));
    await file('licenses/renderer.txt', `${text} tampered`);
    await assert.rejects(collectLicenses(root), /supplement hash no longer matches/);
    await file('licenses/renderer.txt', text);
    await file('node_modules/renderer/package.json', JSON.stringify({ name: 'renderer', version: '1.0.1', license: 'MIT' }));
    await assert.rejects(collectLicenses(root), /Missing distributed license text for renderer@1.0.1/);
  });
});

test('the installed npm tree inventories physical nested packages and rejects missing texts, changed versions and extra packages', async () => {
  await fixture(async (root, file) => {
    const runtime = join(root, 'npm');
    await file('npm/package.json', JSON.stringify({ name: 'npm', version: '12.2.2', license: 'Artistic-2.0' }));
    await file('npm/LICENSE', 'npm license');
    await file('npm/node_modules/nested/package.json', JSON.stringify({ name: 'nested', version: '1.0.0', license: 'ISC' }));
    await file('npm/node_modules/nested/LICENSE', 'nested ISC license');
    await file('npm/node_modules/nested/dist/esm/package.json', '{"type":"module"}');
    await file('npm/node_modules/nested/node_modules/shared/package.json', JSON.stringify({ name: 'shared', version: '2.0.0', license: 'MIT' }));
    await file('npm/node_modules/nested/node_modules/shared/LICENSE', 'shared MIT license');
    const inventory = await prepareInstalledLicenses(runtime, root);
    assert.equal(inventory.dependencies.length, 3);
    const notices = await readFile(join(runtime, 'PIDECK-THIRD-PARTY-NOTICES.txt'), 'utf8');
    assert.ok(notices.includes('nested ISC license'));
    assert.ok(notices.includes('shared MIT license'));
    await prepareInstalledLicenses(runtime, root);
    assert.equal(await readFile(join(runtime, 'PIDECK-THIRD-PARTY-NOTICES.txt'), 'utf8'), notices, 'generation must not collect its own output');
    await file('npm/PIDECK-THIRD-PARTY-NOTICES.txt', `${notices} tampered`);
    await assert.rejects(validateInstalledLicenses(runtime), /notice hash is invalid/);
    await file('npm/PIDECK-THIRD-PARTY-NOTICES.txt', notices);
    await file('npm/node_modules/nested/package.json', JSON.stringify({ name: 'nested', version: '2.0.0', license: 'ISC' }));
    await assert.rejects(validateInstalledLicenses(runtime), /does not cover nested@2.0.0/);
    await file('npm/node_modules/nested/package.json', JSON.stringify({ name: 'nested', version: '1.0.0', license: 'ISC' }));
    await file('npm/node_modules/new-package/package.json', JSON.stringify({ name: 'new-package', version: '1.0.0', license: 'MIT' }));
    await assert.rejects(validateInstalledLicenses(runtime), /no longer matches/);
    await assert.rejects(prepareInstalledLicenses(runtime, root), /Missing distributed license text for new-package@1.0.0/);
  });
});

test('installed license supplements preserve author provenance and upstream README attribution without relying on a declared SPDX identifier alone', async () => {
  await fixture(async (root, file) => {
    const text = 'complete standard ISC license text';
    const sha256 = createHash('sha256').update(text).digest('hex');
    await file('licenses/supplements.json', JSON.stringify({ 'npm@12.2.2': {
      license: 'ISC', file: 'standard.txt', sha256, source: 'https://example.invalid/pinned/ISC.txt',
      declaration: 'https://example.invalid/pinned/package.json', attribution: 'Upstream author, from the fixed package manifest.', readmeAttribution: true,
    } }));
    await file('licenses/standard.txt', text);
    await file('npm/package.json', JSON.stringify({ name: 'npm', version: '12.2.2', license: 'ISC' }));
    await file('npm/README.md', 'Example\n\n## Copyright and Licensing\nOriginal upstream attribution.');
    const runtime = join(root, 'npm');
    await prepareInstalledLicenses(runtime, root);
    const notices = await readFile(join(runtime, 'PIDECK-THIRD-PARTY-NOTICES.txt'), 'utf8');
    for (const value of [text, 'Original upstream attribution.', 'Upstream author', 'https://example.invalid/pinned/package.json']) assert.ok(notices.includes(value));
    await file('npm/package.json', JSON.stringify({ name: 'npm', version: '12.2.3', license: 'ISC' }));
    await assert.rejects(prepareInstalledLicenses(runtime, root), /Missing distributed license text/);
  });
});

test('the final ASAR must retain complete license texts matching the generated inventory', async () => {
  await fixture(async root => {
    await prepareLicenses(root);
    const archive = join(root, 'app.asar');
    await asar.createPackage(root, archive);
    assert.equal((await validatePackagedLicenses(archive)).dependencies.length, 4);
    const path = join(root, 'dist/licenses/THIRD_PARTY_NOTICES.txt');
    await writeFile(path, (await readFile(path, 'utf8')).replace('renderer license', ''));
    await assert.rejects(validateLicenses(join(root, 'dist/licenses')), /license texts do not match/);
  });
});

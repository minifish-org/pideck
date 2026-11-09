import assert from 'node:assert/strict';
import { createPublicKey, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const { prepareUpdaterAssets, prepareUpdaterTools, publishUpdaterAssets, validateUpdaterResources } = await import(
  new URL('../scripts/update-assets.mjs', import.meta.url).href,
) as {
  prepareUpdaterAssets(platform: string, arch: string, root: string): Promise<unknown>;
  prepareUpdaterTools(root: string): Promise<unknown>;
  publishUpdaterAssets(context: unknown): Promise<unknown>;
  validateUpdaterResources(contents: string, expected?: { platform?: string; arch?: string }): Promise<unknown>;
};

const manifest = {
  schema: 1, platform: 'darwin', arch: 'arm64', sparkleVersion: '2.10.1',
  sparkleArchiveSha256: '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27',
  electronVersion: '45.2.3', electronHeadersSha256: '5300f8e7965734f7cc1aec0c89ce8c0b68644129b858fb0a530ebbd9cd4a4284',
  napiVersion: 8, minimumSystemVersion: '14.0', framework: 'Frameworks/Sparkle.framework',
  native: 'Resources/native/pideck-sparkle.node',
};

async function writeManifest(contents: string, value: unknown = manifest) {
  const path = join(contents, 'Resources/updater/manifest.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

test('shipping update configuration uses an Ed25519 public key and requires signed metadata and payloads', async () => {
  const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const publicKey = (await readFile(new URL('../resources/updater-public-key.txt', import.meta.url), 'utf8')).trim();
  const config = packageInfo.build.mac.extendInfo;
  // The packaging hook embeds this public resource before signing the app;
  // packaged acceptance separately verifies the actual Info.plist embedding.
  const raw = Buffer.from(publicKey, 'base64');
  assert.equal(raw.length, 32);
  assert.equal(raw.toString('base64'), publicKey);
  assert.equal(createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
    format: 'der', type: 'spki' }).asymmetricKeyType, 'ed25519');
  const feed = new URL(config.SUFeedURL);
  assert.equal(feed.protocol, 'https:');
  assert.equal(feed.origin, 'https://github.com');
  assert.equal(feed.pathname, '/minifish-org/pideck/releases/latest/download/appcast.xml');
  assert.equal(feed.username + feed.password + feed.search + feed.hash, '');
  assert.equal(config.SUVerifyUpdateBeforeExtraction, true);
  assert.equal(config.SURequireSignedFeed, true);
  assert.equal(config.SUSignedFeedFailureExpirationInterval, 0);
  assert.equal(config.SUEnableAutomaticChecks, true);
  assert.equal(config.SUAllowsAutomaticUpdates, false);
  assert.notEqual(config.SUEnableJavaScript, true);
  assert.notEqual(config.SUEnableSystemProfiling, true);
  assert.notEqual(config.SUEnableInstallerLauncherService, true);
  assert.notEqual(config.SUEnableDownloaderService, true);
  assert.equal(packageInfo.devDependencies.electron, manifest.electronVersion);
});

test('non-macOS packaging neither loads macOS tools nor reads or writes a native updater tree', async () => {
  const unavailableRoot = join(tmpdir(), `pideck-no-updater-${randomUUID()}`);
  for (const platform of ['linux', 'win32']) {
    assert.equal(await prepareUpdaterAssets(platform, 'x64', unavailableRoot), undefined);
    assert.equal(await publishUpdaterAssets({ packager: { platform: { nodeName: platform } } }), undefined);
  }
  await assert.rejects(readFile(unavailableRoot), { code: 'ENOENT' });
});

test('macOS updater preparation rejects unsupported targets and mismatched Electron headers before download', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pideck-updater-header-pin-'));
  try {
    await assert.rejects(prepareUpdaterAssets('darwin', 'universal', temporary), /macOS builder targeting arm64 or x64/);
    if (process.platform !== 'darwin') return;
    await mkdir(join(temporary, 'node_modules/electron'), { recursive: true });
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ devDependencies: { electron: manifest.electronVersion } }));
    await writeFile(join(temporary, 'node_modules/electron/package.json'), JSON.stringify({ version: '0.0.0' }));
    await assert.rejects(prepareUpdaterAssets('darwin', 'arm64', temporary), /pinned Electron version/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('release tools reject a poisoned archive cache before extraction or execution', { skip: process.platform !== 'darwin' }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pideck-updater-archive-pin-'));
  try {
    const cache = join(temporary, 'release/updater-downloads');
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, 'Sparkle-2.10.1.tar.xz'), 'tampered archive');
    await assert.rejects(prepareUpdaterTools(temporary), /does not match its pinned checksum/);
    await assert.rejects(readFile(join(temporary, 'release/updater-tools/2.10.1/bin/sign_update')), { code: 'ENOENT' });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('updater manifests reject dependency substitution, target mismatch and relocated executable paths', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pideck-updater-manifest-'));
  try {
    for (const change of [
      { sparkleVersion: '0.0.0' }, { sparkleArchiveSha256: '0'.repeat(64) },
      { electronVersion: '0.0.0' }, { electronHeadersSha256: '0'.repeat(64) }, { napiVersion: 1 },
      { native: '../outside.node' }, { framework: '../Outside.framework' }, { arch: 'universal' },
    ]) {
      await writeManifest(temporary, { ...manifest, ...change });
      await assert.rejects(validateUpdaterResources(temporary), /pinned dependencies or package target/);
    }
    await writeManifest(temporary);
    await assert.rejects(validateUpdaterResources(temporary, { arch: 'x64' }), /package target/);
    await assert.rejects(validateUpdaterResources(temporary, { platform: 'linux' }), /package target/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('versioned framework links stay portable when updater resources leave the build cache', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'pideck-updater-portable-'));
  const contents = join(temporary, 'Contents');
  const framework = join(contents, manifest.framework);
  try {
    await writeManifest(contents);
    await mkdir(join(framework, 'Versions/B/Resources'), { recursive: true });
    await writeFile(join(framework, 'Versions/B/Resources/payload'), 'fixture');
    await symlink('B', join(framework, 'Versions/Current'), 'dir');
    await symlink('Versions/Current/Resources', join(framework, 'Resources'), 'dir');
    const relocated = join(temporary, 'relocated');
    await cp(contents, relocated, { recursive: true, verbatimSymlinks: true });
    await rename(contents, join(temporary, 'unavailable-source'));
    // A portable framework reaches the next required-resource check. No real
    // binary or platform command is needed to verify this link boundary.
    await assert.rejects(validateUpdaterResources(relocated), /missing or empty: Resources\/native\/pideck-sparkle.node/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

for (const kind of ['absolute', 'relative escape', 'dangling', 'cycle'] as const) {
  test(`updater packaging rejects a ${kind} framework link`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'pideck-updater-link-'));
    const contents = join(temporary, 'Contents');
    const framework = join(contents, manifest.framework);
    try {
      await writeManifest(contents);
      await mkdir(framework, { recursive: true });
      await writeFile(join(temporary, 'outside'), 'not a bundle resource');
      const target = kind === 'absolute' ? join(temporary, 'outside')
        : kind === 'relative escape' ? '../../../outside' : kind === 'cycle' ? 'link' : 'missing';
      await symlink(target, join(framework, 'link'));
      await assert.rejects(validateUpdaterResources(contents));
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}

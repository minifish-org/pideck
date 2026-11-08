import assert from 'node:assert/strict';
import test from 'node:test';

type Options = {
  platform: string;
  env: Record<string, string | undefined>;
  config?: Record<string, unknown>;
  findIdentity(type: string): Promise<unknown>;
};
const { preparePackageArgs } = await import(new URL('../scripts/package.mjs', import.meta.url).href) as {
  preparePackageArgs(args: string[], options: Options): Promise<string[]>;
};

test('a macOS output-directory override retains ad-hoc signing when neither application identity exists', async () => {
  const lookups: string[] = [];
  const input = ['--mac', 'dmg', 'zip', '-c.directories.output=release/candidate'];
  const args = await preparePackageArgs(input, {
    platform: 'darwin', env: {}, config: {},
    findIdentity: async type => { lookups.push(type); return undefined; },
  });
  assert.deepEqual(args, ['--dir', '--publish', 'never', ...input, '-c.mac.identity=-']);
  assert.deepEqual(lookups, ['Developer ID Application', 'Mac Developer']);
  assert.deepEqual(input, ['--mac', 'dmg', 'zip', '-c.directories.output=release/candidate']);
});

test('a usable macOS application certificate is left for electron-builder to select', async () => {
  const lookups: string[] = [];
  const args = await preparePackageArgs(['--config.directories.output=release/candidate'], {
    platform: 'darwin', env: {},
    findIdentity: async type => { lookups.push(type); return { name: 'Available application identity' }; },
  });
  assert.deepEqual(args, ['--dir', '--publish', 'never', '--config.directories.output=release/candidate']);
  assert.deepEqual(lookups, ['Developer ID Application']);
});

test('explicit signing properties and external config files bypass automatic identity discovery', async () => {
  const options: Options = { platform: 'darwin', env: {},
    findIdentity: async () => { throw new Error('explicit signing must not query certificates'); } };
  for (const input of [
    ['-c.mac.identity=-'], ['--config.mac.identity=null'], ['-c.mac.identity', 'My Identity'],
    ['-c.mac.notarize=false'], ['--config.mac.notarize.teamId=TEAM'], ['--config.cscLink=signing.p12'],
    ['--config', 'electron-builder.yml'], ['-c=electron-builder.yml'],
  ]) assert.deepEqual(await preparePackageArgs(input, options), ['--dir', '--publish', 'never', ...input]);
});

test('signing environment and package configuration remain explicit even for false or empty values', async () => {
  const findIdentity = async () => { throw new Error('explicit signing must not query certificates'); };
  for (const env of [{ CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, { CSC_LINK: '' }, { APPLE_KEYCHAIN_PROFILE: 'profile' }]) {
    assert.deepEqual(await preparePackageArgs([], { platform: 'darwin', env, findIdentity }), ['--dir', '--publish', 'never']);
  }
  for (const config of [{ forceCodeSigning: false }, { mac: { identity: null } }, { mac: { notarize: false } }]) {
    assert.deepEqual(await preparePackageArgs([], { platform: 'darwin', env: {}, config, findIdentity }), ['--dir', '--publish', 'never']);
  }
});

test('non-macOS packaging never queries macOS signing identities', async () => {
  for (const platform of ['linux', 'win32']) {
    const args = await preparePackageArgs(['--publish', 'never'], { platform, env: {},
      findIdentity: async () => { throw new Error('unexpected macOS certificate lookup'); } });
    assert.deepEqual(args, ['--dir', '--publish', 'never', '--publish', 'never']);
  }
});

test('a failed identity lookup stops packaging instead of silently downgrading the signature', async () => {
  await assert.rejects(preparePackageArgs([], { platform: 'darwin', env: {},
    findIdentity: async () => { throw new Error('identity lookup failed'); } }), /identity lookup failed/);
});

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const signingEnvironment = [
  "CSC_LINK", "CSC_NAME", "CSC_KEY_PASSWORD", "CSC_KEYCHAIN",
  "CSC_INSTALLER_LINK", "CSC_INSTALLER_KEY_PASSWORD", "CSC_IDENTITY_AUTO_DISCOVERY", "CSC_FOR_PULL_REQUEST",
  "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID",
  "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE",
];
const signingKeys = ["cscLink", "cscKeyPassword", "forceCodeSigning"];
const macSigningKeys = ["identity", "sign", "type", "notarize", "cscLink", "cscKeyPassword", "cscInstallerLink", "cscInstallerKeyPassword"];

function signingArgument(argument) {
  // A config file can supply signing settings we cannot infer from the CLI.
  if (/^(?:-c|--config)(?:=|$)/.test(argument)) return true;
  const key = /^(?:-c|--config)\.([^=]+)/.exec(argument)?.[1];
  return signingKeys.includes(key) || macSigningKeys.some(name => key === `mac.${name}` || key?.startsWith(`mac.${name}.`));
}

export async function preparePackageArgs(args, { platform, env, config = {}, findIdentity }) {
  const result = ["--dir", "--publish", "never", ...args];
  if (platform === "darwin") {
    const explicitSigning = args.some(signingArgument)
      || signingEnvironment.some(name => Object.hasOwn(env, name))
      || signingKeys.some(key => Object.hasOwn(config, key))
      || macSigningKeys.some(key => Object.hasOwn(config.mac ?? {}, key));
    if (explicitSigning) return result;
    // Use the pinned builder's own candidate filtering: an iOS certificate is
    // not a usable macOS identity. A failed lookup rejects rather than downgrades.
    const identity = await findIdentity("Developer ID Application") ?? await findIdentity("Mac Developer");
    // These are the builder's default non-MAS application certificate choices.
    // 26.18 otherwise skips signing when neither is available.
    if (!identity) result.push("-c.mac.identity=-");
  }
  return result;
}

async function main() {
  const args = await preparePackageArgs(process.argv.slice(2), {
    platform: process.platform,
    env: process.env,
    config: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).build,
    findIdentity: async type => {
      const { findIdentity } = await import("app-builder-lib/out/codeSign/macCodeSign.js");
      return findIdentity(type);
    },
  });
  const builder = fileURLToPath(new URL("../node_modules/electron-builder/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [builder, ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

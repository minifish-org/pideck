import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const signingEnvironment = [
  "CSC_LINK", "CSC_NAME", "CSC_KEY_PASSWORD", "CSC_KEYCHAIN",
  "CSC_INSTALLER_LINK", "CSC_INSTALLER_KEY_PASSWORD", "CSC_IDENTITY_AUTO_DISCOVERY", "CSC_FOR_PULL_REQUEST",
  "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID",
  "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE",
];

if (process.platform === "darwin") {
  const config = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).build;
  const explicitConfig = args.some(arg => /^(?:-c|--config)(?:[.=]|$)/.test(arg));
  const explicitSigning = signingEnvironment.some(name => Object.hasOwn(process.env, name))
    || ["cscLink", "cscKeyPassword", "forceCodeSigning"].some(key => Object.hasOwn(config, key))
    || ["identity", "sign", "type", "notarize", "cscLink", "cscKeyPassword", "cscInstallerLink", "cscInstallerKeyPassword"]
      .some(key => Object.hasOwn(config.mac ?? {}, key));
  if (!explicitConfig && !explicitSigning) {
    // Use the pinned builder's own candidate filtering: an iOS certificate is
    // not a usable macOS identity. A failed lookup rejects rather than downgrades.
    const { findIdentity } = await import("app-builder-lib/out/codeSign/macCodeSign.js");
    const identity = await findIdentity("Developer ID Application") ?? await findIdentity("Mac Developer");
    // These are the builder's default non-MAS application certificate choices.
    // 26.18 otherwise skips signing when neither is available.
    if (!identity) args.push("-c.mac.identity=-");
  }
}

const builder = fileURLToPath(new URL("../node_modules/electron-builder/cli.js", import.meta.url));
const result = spawnSync(process.execPath, [builder, "--dir", ...args], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;

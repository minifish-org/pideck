import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publishAutomation } from "./package-assets.mjs";
import { validatePackagedLicenses } from "./licenses.mjs";
import { publishUpdaterAssets } from "./update-assets.mjs";

const run = promisify(execFile);

export default async function afterPack(context) {
  if (context.packager.platform.nodeName === "darwin") {
    const key = (await readFile(join(context.packager.projectDir, "resources/updater-public-key.txt"), "utf8")).trim();
    const info = context.packager.config.mac?.extendInfo;
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32
      || info?.SUPublicEDKey !== undefined
      || info.SUFeedURL !== "https://github.com/minifish-org/pideck/releases/latest/download/appcast.xml"
      || info.SURequireSignedFeed !== true || info.SUVerifyUpdateBeforeExtraction !== true
      || info.SUSignedFeedFailureExpirationInterval !== 0) {
      throw new Error("Release updater configuration must use the pinned public key and fail-closed signed HTTPS feed.");
    }
    // One public resource is the source of truth. This runs before the final
    // bundle signature; the private release key is never read while packaging.
    await run("/usr/libexec/PlistBuddy", ["-c", `Add :SUPublicEDKey string ${key}`,
      join(dirname(context.packager.getResourcesDir(context.appOutDir)), "Info.plist")]);
  }
  await publishAutomation(context);
  await publishUpdaterAssets(context);
  await validatePackagedLicenses(join(context.packager.getResourcesDir(context.appOutDir), "app.asar"));
}

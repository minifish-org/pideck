import { join } from "node:path";
import { publishAutomation } from "./package-assets.mjs";
import { validatePackagedLicenses } from "./licenses.mjs";

export default async function afterPack(context) {
  await publishAutomation(context);
  await validatePackagedLicenses(join(context.packager.getResourcesDir(context.appOutDir), "app.asar"));
}

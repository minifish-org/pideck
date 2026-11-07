// Commander detects packaged Electron as an app with no script argv. The CLI
// and its native daemon are Node scripts instead. Load only in that CLI tree.
if (process.env.ELECTRON_RUN_AS_NODE === '1') {
  (process as NodeJS.Process & { defaultApp: boolean }).defaultApp = true;
}

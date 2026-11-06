const shellKeys = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TMPDIR", "TMP", "TEMP",
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "HOMEDRIVE", "HOMEPATH", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMDATA",
  "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
]);

export function shellEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value && (shellKeys.has(key) || /^LC_[A-Z_]+$/.test(key)
      || (process.platform === "win32" && [...shellKeys].some(allowed => allowed.toLowerCase() === key.toLowerCase())))) {
      env[key] = value;
    }
  }
  if (process.platform !== "win32") {
    const path = env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin";
    env.PATH = process.platform === "darwin" ? path + ":/opt/homebrew/bin:/usr/local/bin" : path;
  }
  return env;
}

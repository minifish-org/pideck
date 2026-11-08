export type AutomationProfile = {
  schema: 1;
  owner: string;
  projectId: string;
  conversationId: string;
  projectDirectory: string;
  node: string;
  cli: string;
  playwright: string;
  browsers: string;
  home: string;
  output: string;
  runtime: string;
  session: string;
};

export function cliEnvironment(profile: AutomationProfile, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...source,
    HOME: profile.home,
    USERPROFILE: profile.home,
    APPDATA: `${profile.home}/AppData/Roaming`,
    LOCALAPPDATA: `${profile.home}/AppData/Local`,
    XDG_CACHE_HOME: `${profile.home}/.cache`,
    XDG_CONFIG_HOME: `${profile.home}/.config`,
    XDG_RUNTIME_DIR: profile.runtime,
    // Both the Unix socket fallback and Windows named pipes include this name.
    USER: profile.session,
    USERNAME: profile.session,
    TMPDIR: profile.runtime,
    TMP: profile.runtime,
    TEMP: profile.runtime,
    NO_UPDATE_NOTIFIER: '1',
    PLAYWRIGHT_BROWSERS_PATH: profile.browsers,
    PLAYWRIGHT_CLI_SESSION: profile.session,
  };
}

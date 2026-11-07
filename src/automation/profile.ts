export type AutomationProfile = {
  schema: 1;
  owner: string;
  projectId: string;
  conversationId: string;
  projectDirectory: string;
  node: string;
  prelude: string;
  cli: string;
  chromium: string;
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
    ELECTRON_RUN_AS_NODE: '1',
    // Node parses this environment value itself; JSON quoting preserves spaces,
    // quotes and Windows backslashes without involving the shell.
    NODE_OPTIONS: [source.NODE_OPTIONS, `--require=${JSON.stringify(profile.prelude)}`].filter(Boolean).join(' '),
  };
}

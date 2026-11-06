# Pideck

Pideck is an experimental desktop coding workspace. Each project opens in a local folder with its own Pi Durable conversations, Git review panel, and interactive terminal.

## Run locally

Use Node.js 22.19 or later.

```sh
npm ci
npm run dev
```

Open a project folder, review its permissions, and create a session. The project switcher at the top of the sidebar lists your saved folders and lets you open another one. **Model providers** offers each provider’s available connection methods. These may include an API key, browser sign-in, a device code, or a provider-specific configuration prompt. The model picker shows the native catalog and offers the thinking levels supported by each model. Connected providers with dynamic catalogs can refresh their model list.

During a run, **Steer run** sends an instruction at Durable’s next turn boundary. **Queue next** runs the input as a follow-up. Use **Summarize context** to free up model context and **Branch from here** on a committed message to create a separate session. **Load earlier** opens more of the transcript. The full conversation is stored in SQLite.

**Remove** is available beside each project and session. Session removal clears its conversation, tool output, and draft. Remove any branches before removing their parent session. Project removal stops its terminal and clears all its sessions and local workspace settings. Files in the project folder are kept. Reopening a removed folder starts a new workspace and asks for trust again. Finish or stop work in other sessions before removing stored conversation data.

Small tool edits expand in chat. **Changes** opens alongside chat when the workspace is wide enough and takes over the workspace at smaller sizes. The diff layout automatically fits the review pane and can be changed from its layout menu. The sidebar opens over the workspace in narrow windows. The terminal starts in the project folder and keeps running while you review or switch projects. Its search covers the retained scrollback, which stays visible if the workspace process restarts and starts a new shell.

Provider credentials are encrypted through the operating system’s credential store. Supported provider environment variables are available to pi-ai in the trusted workspace process. Pideck excludes them from tool, review, and terminal subprocess environments. On Linux, saving credentials requires a system secret store. Trusted projects let Pideck run commands with your user account’s permissions. Only trust folders whose contents you trust.

| Action | Shortcut |
| --- | --- |
| Open folder | ⌘/Ctrl+O |
| New session | ⌘/Ctrl+N |
| Open model providers | ⌘/Ctrl+, |
| Toggle navigation | ⌘/Ctrl+Shift+B |
| Toggle review | ⌘/Ctrl+Shift+D |
| Toggle terminal | ⌘/Ctrl+` |
| Focus prompt | ⌘/Ctrl+L |
| Find in terminal | ⌘F on macOS, Ctrl+Shift+F elsewhere |
| Navigate sidebar rows | ↑/↓, then Enter to select |
| Request removal of a sidebar row | Delete while the row has focus |

## Verify and package

```sh
npm run typecheck
npm test
npm run verify:frontend
npm run package
npm run smoke:packaged
```

Install a test browser with `npx playwright-cli install-browser chromium` if needed.

The frontend check starts Vite from Durable’s `bash` tool, drives an isolated Playwright CLI session, and reads the screenshot through Durable’s image input. It uses a deterministic test model and browser fixture. The packaged smoke test opens the real desktop app with a temporary profile and a local Responses endpoint. It uses pi-ai’s Azure adapter, streams output through Durable, runs the coding tools, reviews the result, and tests recovery by terminating the workspace process mid-request. It also checks native terminal search and resizing. The unpacked desktop bundle is written to `release/`.

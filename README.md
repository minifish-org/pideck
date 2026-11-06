# Pideck

Pideck is an experimental desktop coding workspace. Each project opens in a local folder with its own Pi Durable conversations, Git review panel, and interactive terminal.

## Run locally

Use Node.js 22.19 or later.

```sh
npm ci
npm run dev
```

Open a project folder, review its permissions, and type your first message. Pideck creates the session when you send, and keeps unsent text as a draft. The sidebar lists sessions beneath their project folders. Expand a project to browse its sessions, or use the plus button beside **Projects** to open another folder. **Model providers** offers each provider’s available connection methods. These may include an API key, browser sign-in, a device code, or a provider-specific configuration prompt. The composer shows the selected model and its thinking level. Open its picker to choose from available models and adjust the level when the model supports it. Connected providers with dynamic catalogs can refresh their model list.

During a run, **Queue next** adds the message as a follow-up. Drag a queued message to move it among messages of the same kind, or focus it and use Alt+↑/↓. Its buttons let you edit the text, delete the message, or steer the current run at Durable’s next turn boundary. Use **Branch from here** on a committed message to create a separate session. Durable automatically summarizes older context as the model approaches its limit. The full conversation stays in SQLite and **Load earlier** opens more of the transcript.

New sessions use the first message to suggest a name. Click the session title to rename it, or press F2 on its sidebar row. The sidebar shows when a session is running, finished, or needs attention. The finished or failed indicator clears when you reach the result in the conversation. Pideck remembers the window, the reading position in each session, unsent text, and the last reviewed file.

**Remove** is available beside each project and session. Session removal clears its conversation, tool output, and draft. When branches block a parent’s removal, Pideck lists them and lets you open each one. Remove each branch before removing its parent. Project removal stops its terminal and clears all its sessions and local workspace settings. Files in the project folder are kept. Reopening a removed folder starts a new workspace and asks for trust again. Finish or stop work in other sessions before removing stored conversation data.

Small tool edits expand in chat. Successful shell commands collapse to one line and can be reopened for their full output. **Changes** opens alongside chat in wide windows and takes over the workspace at smaller sizes. While open, it refreshes as files change. The diff layout automatically fits the review pane and can be changed from its layout menu. Drag the review or terminal divider to make room, or double-click it to restore the automatic size. The sidebar opens over the workspace in narrow windows. The terminal starts an interactive shell in the project folder with the shell’s normal startup files. `Ctrl+C` interrupts the foreground command. A clean `exit` closes the panel, and opening **Terminal** again starts a new shell with the previous scrollback available to search. A running shell stays alive while you hide the panel, review changes, or switch projects.

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

Choose **Check for Updates…** from the Pideck menu on macOS or the File menu on Windows and Linux. Pideck compares the installed version with the latest stable GitHub release and opens the release page on request. A private release page opens in your browser so you can use your GitHub sign-in.

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

# Pideck

Pideck is an experimental desktop coding workspace. Each project opens in a local folder with its own Pi Durable conversations, Git review panel, and interactive terminal.

## Run locally

Use Node.js 22.19 or later.

```sh
npm ci
npm run dev
```

Open a project folder, confirm that you trust it, and create a session. **Model settings** lists the chat providers registered by pi-ai and offers each provider’s available connection methods. These may include an API key, browser sign-in, a device code, or a provider-specific configuration prompt. The model picker shows the native catalog and offers the thinking levels supported by each model. Use **Refresh catalog** for providers with dynamic model lists.

During a run, **Steer** sends an instruction at Durable’s next turn boundary. **Queue next** runs the input as a follow-up. The conversation menu can compact model context or fork from a committed turn. Use **Load earlier** to open more of the transcript. The full conversation is stored in SQLite.

**Remove** is available beside each project and session. Session removal clears its conversation, tool output, and draft. Remove any branches before removing their parent session. Project removal stops its terminal and clears all its sessions and local workspace settings. Files in the project folder are kept. Reopening a removed folder starts a new workspace and asks for trust again. Finish or stop work in other sessions before removing stored conversation data.

Small tool edits expand in chat. Open larger patches in **Changes** for file navigation, syntax highlighting, line selection, and unified or split layout. The terminal starts in the project folder. Its search covers the retained scrollback, which stays visible if the workspace process restarts and starts a new shell.

Provider credentials are encrypted through the operating system’s credential store. Supported provider environment variables are available to pi-ai in the trusted workspace process. Pideck excludes them from tool, review, and terminal subprocess environments. On Linux, saving credentials requires a system secret store. Trusted projects let Pideck run commands with your user account’s permissions. Only trust folders whose contents you trust.

| Action | Shortcut |
| --- | --- |
| Open folder | ⌘/Ctrl+O |
| New session | ⌘/Ctrl+N |
| Open settings | ⌘/Ctrl+, |
| Toggle navigation | ⌘/Ctrl+Shift+B |
| Toggle review | ⌘/Ctrl+Shift+D |
| Toggle terminal | ⌘/Ctrl+` |
| Focus prompt | ⌘/Ctrl+L |
| Find in terminal | ⌘/Ctrl+F while terminal has focus |

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

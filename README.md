# Pideck

Pideck is an experimental desktop coding workspace. Each project opens in a local folder with its own Pi Durable conversations, Git review panel, and interactive terminal.

## Install and requirements

Download versioned builds from [GitHub Releases](https://github.com/minifish-org/pideck/releases). The v0.1.1 download targets macOS 14 or later on Apple Silicon (arm64). It is ad-hoc signed, without Developer ID signing or Apple notarization. macOS may refuse to open a downloaded build. Do not disable Gatekeeper or other system protections to install it; building from source is available below.

Install Git and keep it on `PATH` for change review. Windows also needs [Git for Windows](https://gitforwindows.org/) with Git Bash for the agent's `bash` tool; PowerShell alone does not provide that tool. Packaged builds include their own Node.js, npm, npx, and Playwright CLI, so a separate Node.js installation is unnecessary for normal packaged use. The first browser task needs an internet connection to obtain Playwright's matching browser and FFmpeg directly from their upstream download services; later tasks reuse the application-data cache.

| Platform | Requirements and validation |
| --- | --- |
| macOS | macOS 14 or later, as required by the pinned browser installer. The packaged workflow has been exercised on Apple Silicon (arm64); Intel (x64) is a packaging target awaiting native acceptance. |
| Windows | x64 packaging target. Git for Windows/Git Bash is required; native acceptance is pending. |
| Linux | x64 and arm64 packaging targets, with Chromium's supported operating-system libraries and a working desktop secret store. Native acceptance is pending. |

These are packaging targets, not a claim that every operating-system release or architecture has completed product acceptance. Release notes must state the targets actually tested for that artifact.

## Run locally

Use Node.js 22.23.4 for the build, matching CI and the bundled runtime, and the Git/Bash requirements above. Native dependencies may require your platform's C/C++ build tools if a matching prebuilt binary is unavailable.

```sh
npm ci
npm run dev
```

The first development launch prepares the bundled Node.js and Playwright CLI before building the app. This downloads fixed upstream versions into `release/automation-downloads/`; later preparations reuse the verified download cache. `npm run build` only compiles the app and does not download browser executables. To prepare the tools separately, run `npm run prepare:automation`. Browser executables are prepared by the pinned upstream installer when first needed, under application data.

Choose a project folder to begin. Opening it allows Pideck to read, edit, and run commands with your user account’s permissions, including outside that folder. Pideck creates the session when you send your first message and keeps unsent text as a draft. Expand a project in the sidebar to browse its sessions. Hover over or focus a project to reveal its plus button and start a session there. The plus button beside **Projects** opens another folder. **Model providers** offers each provider’s available connection methods. These may include an API key, browser sign-in, a device code, or a provider-specific configuration prompt. Choose a model and, when supported, its thinking level in the same composer menu. Connected providers with dynamic catalogs can refresh their model list. Pasted images appear as thumbnails, and images in the composer or conversation open a full preview when clicked.

During a run, the queue icon (**Queue next**) adds the message as a follow-up. Drag a queued message to move it among messages of the same kind, or focus it and use Alt+↑/↓. Its buttons let you edit the text, delete the message, or steer the current run at Durable’s next turn boundary. Editing uses the main composer: save with the check button or Enter, and cancel with × or Esc. Your ordinary draft returns afterward. While you edit, that message and the messages queued behind it wait in place, even when the current task finishes. Saving sends the revised text when its turn arrives; cancelling keeps the original text. Closing the window, restarting the app, or reconnecting its workspace process preserves the edit and queue position. Reopen to continue editing; only Save or Cancel releases the message. Use **Branch from here** on a committed assistant reply to create a separate session. Durable automatically summarizes older context as the model approaches its limit. The full conversation stays in SQLite and **Load earlier** opens more of the transcript.

The run control sits directly above the composer. **Cancel run** stops the conversation’s current work and withdraws its queued messages, including a queued message being edited; completed file changes remain. While the queue is nonempty, the control row shows that cancellation includes the queue. A running tool card offers **Cancel this tool**, which stops only that tool and reports its cancellation to the model so the rest of the run can continue. After cancellation or a failed run, **Continue** appears when there is unanswered context. It uses Durable’s native continuation without adding a user message or sending the composer draft. Automatic model retries, provider waits, and recovery after a workspace restart share the same status row. While a run is active, a compact clock beside its control continuously shows the elapsed time from that run’s actual start, including tool rounds and retry waits. Reopening the session keeps the same start time. When the run completes, fails, or is cancelled, the clock stops at its final total and remains in the same position; reopening keeps that total. The next run, including Continue, starts a new clock. Normal completion keeps the same stop button beside the final elapsed time, greyed out and disabled.

New sessions use a short heading from the first message. The title bar shows the current session on the left. **Changes** and **Terminal** sit at the window’s right edge when the right sidebar is closed and move to the active panel’s upper-right corner when it’s open. When starting a new session, the project name appears until the first message is sent. Click the session title, double-click its row in the docked sidebar, or press F2 on that row to rename it. The sidebar shows when a session is running, finished, or needs attention. The finished or failed indicator clears when you reach the result in the conversation. Pideck remembers the window, the reading position in each session, unsent text, and the last reviewed file.

Completed results stay unread across relaunches until you view them. Background completion or failure sends a brief system notification; an actively viewed session stays quiet. Notifications contain no project paths, prompts, or code. Click a notification to reopen its session and show the result. Reading that result or removing its session clears the reminder. On macOS, the Dock badge counts unread completed sessions and follows the system's notification permissions; the app first requests permission when a background reminder is needed, rather than at launch. Focus modes and notification settings remain under the operating system's control.

On macOS, closing the window keeps AI work and project shells running, including services started in the terminal. Clicking the Dock icon reopens the workspace; opening the app again restores a minimized window. Quitting ends the host and shells, with one confirmation only while AI work is active. Saved conversations and unread results remain available when you reopen. Drop a project folder onto the Dock icon to open it, or use **Open Folder…** in its Dock menu. The native window title follows the current session and project. After sleep, Pideck refreshes its read-only views without resending messages, replaying shell input, or replacing a healthy shell.

**Remove** is available beside each project and session. Session removal clears its conversation, tool output, and draft. When branches block a parent’s removal, Pideck lists them and lets you open each one. Remove each branch before removing its parent. Project removal stops its terminal and clears all its sessions and local workspace settings. Files in the project folder are kept. Reopening a removed folder starts a new workspace. Finish or stop work in other sessions before removing stored conversation data.

Small tool edits expand in chat. Larger edits open in **Changes**, where saved patches are marked **From chat**. Select a changed file to switch from a saved patch to its current Git diff. While open, Changes refreshes as files change. User messages and the final answer of each completed run reveal their timestamps and actions together on hover or keyboard focus. AI timestamps, Copy, and Fork appear once beneath that final answer; intermediate text and tool rounds do not repeat these controls. Elapsed time is shown by the live run clock rather than beside message timestamps. Copy includes the selected message’s visible text and tool output without serialized tool arguments. Short command output stays visible after success; long commands use a one-line summary until explicitly expanded. Longer output can be expanded, and an explicit choice to expand or collapse survives command completion. **Changes** and **Terminal** share the right sidebar. Click either button in the chat header to show that tool, or click the active button to close the sidebar. Changes keeps its selected diff, layout, and scroll position when you switch tools or close the sidebar. Drag the sidebar edge to resize it or double-click to reset it. At smaller sizes the selected tool fills the workspace and **Back to chat** returns to the conversation. The terminal starts an interactive shell in the project folder with the shell’s normal startup files. `Ctrl+C` interrupts the foreground command. **Restart shell**, in the terminal header, replaces the shell and keeps its scrollback. A clean `exit` closes the panel, and opening **Terminal** again starts a new shell with its previous scrollback preserved. A running shell stays alive while you hide the panel, review changes, or switch projects.

Links in replies open project files in **Changes** and web pages in your browser. Unchanged files open as read-only, syntax-highlighted previews. File links with line numbers select the referenced line in the diff or the full file when that line is outside the changed section. Text previews support UTF-8 files up to 1 MB; unsupported files explain why they cannot be previewed. Paths outside the project and unsupported link types stay plain text. Model choices are grouped by provider; hover over a context value or image icon for the exact capacity and capability.

Choose **View → Appearance → Follow System, Light, or Dark** to change the whole app’s appearance, including terminals, diffs, menus, and dialogs. Pideck remembers the choice. Existing profiles keep Dark until you choose otherwise; new profiles follow the system. Switching appearance keeps running shells, terminal output, and the selected diff, layout, and scroll position.

Provider credentials are encrypted through the operating system’s credential store. Pideck loads saved credentials on demand when choosing, managing, or using a saved connection. Supported provider environment variables are available to pi-ai in the trusted workspace process. Pideck excludes them from tool, review, and terminal subprocess environments. On Linux, saving credentials requires a system secret store.

## Data and privacy

Pideck sends your prompts, attached images, relevant conversation context, and tool results through the model connection you select. Tool results can include source code and command output. Retention and use of those requests are governed by that provider; selecting a local endpoint keeps inference on that endpoint. Browser verification visits the project's URLs and any other URLs requested by the task. Checking for updates makes an anonymous request to GitHub. Pideck does not include a separate product analytics or crash-reporting service.

Conversations, queued work, tool output, drafts, browser session state, and interface preferences are stored locally. Provider credentials are encrypted separately; ordinary chat, code, tool output, drafts, and browser data do **not** have application-level encryption. Protect the computer and its backups accordingly. The default application data directories are:

| Platform | Directory |
| --- | --- |
| macOS | `~/Library/Application Support/pideck/` |
| Windows | `%APPDATA%\pideck\` |
| Linux | `$XDG_CONFIG_HOME/pideck/`, or `~/.config/pideck/` when unset |

An explicit `--user-data-dir` changes that location. `workspace.sqlite` stores project/session metadata, `conversations.sqlite` stores Durable state, and `tool-output/` stores larger tool results. The renderer's local storage holds drafts and view preferences. Isolated Playwright profiles and screenshots are kept under `automation/`; temporary browser sockets may also exist in the operating system's temporary directory. These profiles are separate from your normal browser profile, but pages and browser state can still contain private information.

Use **Remove** in Pideck to remove a session or project and its associated saved work; project files are kept. Provider connections are managed separately under **Model providers**. Uninstalling the application does not remove its data directory, backups, operating-system credential-store entries, or data already sent to a provider. To discard an entire local profile, quit Pideck before deleting its data directory. This also loses its remaining conversations, drafts, settings, and saved connection file; deletion is not a promise of forensic erasure or backup removal.

Keep screenshots, browser storage, logs, `.env` files, and exported conversations out of public bug reports and source commits. See [SECURITY.md](SECURITY.md) for reporting sensitive issues.

## Browser tools and credentials

On macOS, **Always Allow** in a Keychain access prompt remembers access for that Pideck application to that item; it does not authorize other applications. A local ad-hoc rebuild can change the application's signing identity and require approval again. Changing the packaging configuration does not itself remove prompts for an existing Keychain item.

Packaged Pideck includes a fixed standalone Node.js runtime with npm and npx, the complete Playwright CLI, and its matching browser installer. It does not redistribute Chrome for Testing or FFmpeg. At first use, the installer obtains these directly from the upstream service into Pideck's application-data cache; those upstream terms apply. Preparation needs an internet connection and may take time. The browser tool then uses that matching installation rather than a system Node installation or your normal browser cache. Exact versions and resource paths are recorded in `resources/automation/manifest.json` (inside `Contents/Resources/` on macOS), with the bundled tools' licenses and notices alongside the resources. [Browser distribution](docs/BROWSER_DISTRIBUTION.md) records the redistribution boundary and compatibility checks. Each conversation's browser data is separate from your normal browser profile. Playwright CLI remains available through the agent's existing `bash` tool, including its normal headed/headless browser, screenshot, snapshot, tracing, and scripting capabilities.

| Action | Shortcut |
| --- | --- |
| Open folder | ⌘/Ctrl+O |
| New session | ⌘/Ctrl+N |
| Open model providers | ⌘/Ctrl+, |
| Toggle navigation | ⌘/Ctrl+Shift+B |
| Toggle review | ⌘/Ctrl+Shift+D |
| Toggle terminal | ⌘/Ctrl+` |
| Focus prompt | ⌘/Ctrl+L |
| Navigate sidebar rows | ↑/↓, then Enter to select |
| Request removal of a sidebar row | Delete while the row has focus |

Choose **Check for Updates…** from the Pideck menu on macOS or the File menu on Windows and Linux. Pideck anonymously compares the installed version with a public stable GitHub release and opens the release page on request. Private repositories cannot be checked anonymously; use the offered release page in your signed-in browser to download them manually. Automatic download and installation are not implemented.

## Verify and package

```sh
npm run typecheck
npm test
npm audit --audit-level=moderate
npm audit --prefix resources/npm-runtime --omit=dev --audit-level=moderate
npm run check:licenses
npm run verify:frontend
npm run package
npm run check:distribution -- --report output/playwright/distribution.json
npm run smoke:packaged
```

The frontend check uses the same bundled Node.js, CLI, and browser preparation path. Its first browser use needs the upstream download; no manual browser installation is required.

The default packaging command creates an unpacked local bundle. To prepare macOS arm64 download candidates without publishing them:

```sh
npm run package -- --mac dmg zip --arm64 --publish never
```

Before a release, verify the final artifact's licenses and dependency inventory, install it with an isolated application profile and a disposable project, and run the packaged coding/browser workflow. Keep temporary reports and screenshots outside source commits. A build or a unit-test pass is not an installation or native acceptance result. Nothing in the validation workflow publishes a release.

Packaging prepares Node.js and Playwright resources for the actual target and copies them into the app before signing. It verifies the final app's manifest, Node/npm/npx, CLI dependencies, and license notices rather than checking only the staging directory. Browser executables, profiles, and browser download caches are excluded from the app package. Supported targets are macOS and Linux on x64 or arm64, and Windows on x64. Other targets, including macOS universal and Windows arm64, fail explicitly. Linux still requires the operating-system libraries supported by the downloaded browser; preparation does not install system packages. Node.js downloads are checked against pinned SHA-256 values from the official release, and first-use browser downloads use the pinned Playwright installer's matching revision. Resource publication preserves relative symbolic links and rejects links that are absolute, broken, or escape the resource tree. Runtime profiles and output belong in application data; packaged automation resources are not an install or download cache.

The separate npm runtime includes `PIDECK-DEPENDENCIES.json` and `PIDECK-THIRD-PARTY-NOTICES.txt` for every physically installed package, including nested copies. Final packaging validates that inventory and its notice hash. Version-specific missing upstream texts are supplied from the fixed sources documented in [License supplements](licenses/README.md); a package's declared license alone cannot pass the check.

The frontend check starts Vite from Durable’s `bash` tool, drives an isolated Playwright CLI session, and reads the screenshot through Durable’s image input. It uses a deterministic test model and browser fixture. The packaged smoke test opens the real desktop app with a temporary profile and a local Responses endpoint. It uses pi-ai’s Azure adapter, streams output through Durable, runs the coding tools, reviews the result, and tests recovery by terminating the workspace process mid-request. It also checks native terminal input, scrollback, rebuilding, and resizing. The unpacked desktop bundle is written to `release/`.

Run `node scripts/smoke-native.mjs` on macOS after packaging for windowless work, terminal/server survival and reattachment, native folder entry, window titles, quit confirmation, and wake-event resynchronization. This check uses a disposable profile and intercepts notification delivery and Dock calls: its screenshots and adapter assertions do not prove an OS banner, notification authorization, an actual Notification Center click, or hardware sleep/wake. Check those separately with the packaged app and an authorized system notification setting. Native notifications are optional and never block coding if authorization is denied.

On macOS, packaging lets electron-builder select an available signing certificate and respects explicit signing configuration and supported `CSC_*` inputs. With no signing configuration and no usable macOS application identity, the local packaging script explicitly selects ad-hoc signing, including on Apple Silicon; electron-builder 26.18 does not provide that fallback itself. It uses the pinned builder's identity filtering, so an iOS-only certificate does not suppress the fallback. A failed identity lookup stops packaging. An ad-hoc development bundle is not a Developer ID signed or notarized release. Rebuilding it may require a new Keychain approval; reuse the same bundle when checking whether **Always Allow** persists across launches.

For an opt-in macOS Keychain acceptance check, run `npm run smoke:credentials -- --allow-system-keychain`. It uses the actual packaged Pideck identity with a disposable profile and a dummy key. A person must handle any native authorization and observe each of three complete quit/relaunch cycles; the check verifies real decryption, not a cached or mocked credential. It never removes the shared Keychain item. Follow the printed commands and finish with `cleanup` to remove the disposable profile.

## License and source

Pideck is licensed under [AGPL-3.0-only](LICENSE). Its source, build scripts, and dependency lockfile are available in [this repository](https://github.com/minifish-org/pideck). Source for a versioned binary must be available at its matching release tag, with the build commit recorded in its release notes; use that revision when reproducing a report. Bundled dependencies retain their own licenses and notices. The `private` flag in `package.json` prevents accidental npm publication; it does not restrict this source license or GitHub releases.

# Security

Pideck is an experimental desktop coding agent. Opening a project grants the agent your user account's ability to read files, change files, and run commands, including outside that project. A selected working directory is not a sandbox. Use projects and model connections you trust, and review changes before using them elsewhere.

## Reporting an issue

Do not post API keys, sign-in URLs or codes, private source code, conversation exports, browser storage, or unredacted logs in public issues. Revoke a credential with its provider if it has been exposed; removing a report or commit does not revoke it.

If GitHub offers **Report a vulnerability** on the repository's [Security page](https://github.com/minifish-org/pideck/security), use that private channel. Private vulnerability reporting is not assumed to be enabled. If it is unavailable, open an issue requesting a private contact method **without exploit details or sensitive data**, and wait for the maintainer to arrange a channel. Ordinary non-sensitive bugs can be reported in [Issues](https://github.com/minifish-org/pideck/issues).

Include the Pideck version and build commit, operating system and architecture, affected component, reproduction steps in a disposable project, expected behavior, and the impact you observed. Use placeholders for private values. There is no guaranteed response time; until versioned releases are maintained, fixes target the current development revision.

## Boundaries and stored data

- The Electron renderer has sandboxing and context isolation. Privileged work goes through a validated preload interface to trusted main/host processes.
- Agent tools and interactive terminals run with your account's permissions. Untrusted project content and model output can influence their actions; the renderer boundary does not confine those shell commands.
- Provider credentials use the operating system's encrypted credential store. Ordinary chat, drafts, code in tool output, screenshots, and browser state are stored without application-level encryption. See [Data and privacy](README.md#data-and-privacy) for locations and removal behavior.
- Inference requests go to the selected model endpoint and may contain source code, images, and command output. That service's privacy and retention policies apply.
- Browser automation uses isolated conversation profiles. Isolation from your normal browser profile does not make visited pages or saved browser state safe to publish.
- Local macOS builds are ad-hoc signed and are not Apple-notarized releases. Do not disable operating-system security controls to run an unfamiliar build.

## Validation

Use the lockfile, run the checks documented in the README, and scan both reachable Git history and final distribution contents before release. A root dependency audit does not cover the npm dependencies inside the bundled Node.js distribution. Report the package inventory and applicable advisories together, and distinguish an affected dependency version from a demonstrated exploit path.

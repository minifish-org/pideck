# Dependency upgrade fixture

`pi-1.5.0.json` is a SQL schema-and-row export of synthetic Pideck stores
created **with the installed Pi 1.5.0 packages before the dependency upgrade**
(release commit `f9a26365568127461c47a07a37dcb42c140a3ac5`). It contains no real
provider credentials, user conversations, or project files.

The capture used the faux provider and real SQLite storage to:

- complete a built-in `write` tool call and an assistant response;
- fork that completed conversation;
- hold a follow-up input in the native queue-edit document;
- admit a separate request, begin generation in a child process, and terminate
  the child with `SIGKILL` without closing the stores.

The export retains both `workspace.sqlite` and `conversations.sqlite`, including
the interrupted generation's native task/checkpoint records. Only the project
path (`__PIDECK_PROJECT__`) and directory device/inode values are normalized.
The test supplies a new real directory identity at restoration and defers
foreign-key validation until all exported rows have been restored.

`dependency-upgrade.test.ts` opens these old stores with the currently pinned
libraries and checks history, tool results, fork boundaries, native request
recovery without duplicate admission, held queue editing, watch reattachment,
cancellation, and another store reopen. Do not regenerate this fixture using
the upgraded libraries: that would stop testing backward compatibility.

# omp in Tern

This fork of [petekp/inbox](https://github.com/petekp/inbox) adds a decision pane beside the omp transcript. The first open question in an interactive session opens the pane. Close it whenever you like. `/inbox` brings it back or focuses the existing pane. `/inbox full` opens the original four-tab keyboard panel for Status, Asks, Finds and PR actions.

Press **Ctrl+Alt+I** (**Control+Option+I** on macOS) in the omp composer to start answering. The transcript stays visible and keyboard focus stays in omp. A short key guide takes the place of the composer until you leave answer mode, then omp restores your original prompt draft. The sibling pane follows the Tern window’s light or dark theme, terminal and widget colors, and UI font settings.

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous question |
| `h` / `l`, then **Space** | Move to a choice, then select it |
| `1`–`9` | Select a numbered choice on the current question |
| `i`, then **Esc** | Write a reply, then keep the draft and resume navigation. Ctrl+G cancels the current edit in omp |
| `x` | Clear this question’s draft |
| **Enter** / **Shift+Enter** | Send this reply / send all selected replies together |
| `q` or **Esc** | Leave answer mode and resume the original prompt |
| `?` | Show or hide keyboard help |

Select an option or write a reply on any question. **Send this reply** sends just that row. **Send N together** sends every selected row in one omp message, in the displayed order. Other rows can wait. A busy agent receives one follow-up. Choices close when submitted. Written replies keep the question available for further discussion. If a question changes before submission, review it again. Drafts survive a reload of the open pane.

From this checkout, try the bundled extension in a new Tern terminal:

```sh
omp --no-extensions -e "$PWD/omp/dist/host.js"
```

This one-run command disables automatic extension discovery, including the installed upstream Inbox, and explicitly loads this build. To use your usual extensions, disable the upstream copy and link this checkout’s `omp/` package with `omp plugin link "$PWD/omp"`. Start a new omp session afterward. The fork reads the same per-session state as the upstream extension.

The default is to open once when the session has a question. Start omp with `OMP_INBOX_TERN=manual` to open the split only with the shortcut or `/inbox`, or `OMP_INBOX_TERN=off` to use only the original panel. An automatic split restores the previously focused block when Tern still has the new pane focused. Opening it with `/inbox` gives the inbox keyboard focus. Outside Tern, omp uses its existing panel. The pane needs Tern’s `tern browser` command on PATH and a local graphical Tern window. The page is served on loopback by the owning omp process.

The pane receives changes from the session and does no idle polling. Batching several answers also reduces the number of user messages that trigger agent work. Inbox still uses its usual model calls to maintain the ledger and Status after each reply.

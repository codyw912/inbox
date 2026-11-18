# Answering inbox questions in omp

A question appears as a single line above the prompt. Keep typing, switch splits, or press **Ctrl+Alt+I** (**Control+Option+I** on macOS) to answer in place. The transcript stays visible. Leaving review brings back your unfinished prompt. The same extension renders native Tern Surface Protocol components in Tern and terminal rows elsewhere.

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous question |
| `h` / `l`, then **Space** | Move to a choice and stage it |
| `1`–`9` | Stage a numbered choice immediately. ★ marks the recommendation, ✓ your selection |
| `i`, then **Esc** | Write a reply and keep it. Enter inserts a newline. Ctrl+G cancels this edit |
| `v` | Read the full question, choices and context. Scroll with `j` / `k` and press `v` to return |
| `x` | Clear the current staged reply |
| **Enter** | Send the current staged reply |
| `s` or **Shift+Enter** | Send every staged reply together in question order |
| `q` or **Esc** | Return to the prompt |
| `?` | Show the key guide |

Use `/inbox` if your terminal reserves the shortcut. Use `s` for a batch if your terminal sends the same keycode for Enter and Shift+Enter. In a configured Herdr app terminal, `/inbox` opens the Herdr panel and the shortcut opens composer review. Use `/inbox full` for Status, Asks, Finds and PR actions, or `/inbox demo` for the sample panel.

Choices close the question on submission. A written reply keeps it available for further discussion. A busy agent receives a batch as one follow-up. Staged replies survive leaving and re-entering review in the active session. Switching sessions or restarting omp clears unsent drafts. If the agent revises or closes a question, its old answer is discarded.

From this checkout, try the bundled extension in either terminal:

```sh
omp --no-extensions -e "$PWD/omp/dist/host.js"
```

For ongoing use, disable the upstream Inbox extension and run `omp plugin link "$PWD/omp"`. A fresh omp session loads the linked copy. This fork uses the same per-session ledger as [petekp/inbox](https://github.com/petekp/inbox).

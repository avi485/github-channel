# Ask Claude for GitHub PRs (Chrome extension)

Adds "Ask Claude" to GitHub pull request pages. Questions go to the [local service](../server), which runs
`claude -p` in your clone of the repo, and answers stream back into a chat panel. There's one chat per PR, so
the conversation follows you across files.

Each question is sent with the chat's recent turns (up to 20), so follow-ups have context. **Clear** wipes the
chat and starts a new conversation. History is kept in the extension's local storage.

## Install

1. Start the service: `bun start` in `server/` (see [server/README.md](../server/README.md)).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick this `extension/` folder.
3. Click the extension's toolbar icon to open its settings. Copy the token with
   `pbcopy < ~/.config/github-channel/token`, paste it, and click **Save**. **Service** should say "Running" and list the repos it found.

## Use

- **A line:** hover a diff line and click the ✦ button at the right edge of the row.
- **A range or any code:** select text in the diff and click the **✦ Ask Claude** pill.
- **The whole PR:** click **✦ Ask Claude** at the bottom right.

The question is sent with the file path, line range, side (old/new), and the surrounding diff lines.

While Claude works, the panel shows what it's doing (for example `git show abc123:src/a.ts`) and the answer as
it's written.

## How it works

| File | Role |
|---|---|
| `content.js` | Runs on github.com. Finds diff lines, builds the context, renders the panel (in a shadow root). |
| `background.js` | Service worker. Checks the service on port 8790, sends questions, and streams progress and replies. Content scripts can't call 127.0.0.1 from github.com, so all traffic goes through here. |
| `bridge.js` | The HTTP/SSE client, with no `chrome.*` calls. Tested from `server/test/bridge.test.ts`. |
| `options.html` | Pairing token, service status, and the repos it can answer for. |

## Known limits

- Line detection supports GitHub's newer "Files changed" view (`/pull/N/changes`) and the classic one
  (`/pull/N/files`). The new view was checked in split layout; its unified layout is untested. If the ✦ button stops
  appearing, select the code instead: that only needs the file path.
- Each question starts a fresh `claude` process, so expect a few seconds before the first output.
- Questions in one PR's chat are answered one at a time.

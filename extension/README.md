# Ask Claude for GitHub PRs (Chrome extension)

Adds "Ask Claude" to GitHub pull request pages. Questions go to your running Claude Code session through the
[channel server](../channel-server), and answers come back in a chat panel. One chat per PR, so the
conversation follows you across files. History is kept in the extension's local storage.

## Install

1. Start a session with the channel server (see [channel-server/README.md](../channel-server/README.md)).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick this `extension/` folder.
3. Click the extension's toolbar icon to open its settings. Paste the token from `bun run token` (run it in
   `channel-server/`). The **Running sessions** table should list your session.

## Use

- **A line:** hover a diff line and click the ✦ button at the right edge of the row.
- **A range or any code:** select text in the diff and click the **✦ Ask Claude** pill.
- **The whole PR:** click **✦ Ask Claude** at the bottom right.

The question is sent with the file path, line range, side (old/new), and the surrounding diff lines.

If the panel says no session was found, start `claude --dangerously-load-development-channels server:github-channel`
in your local clone of that repo, then click **Retry**.

## How it works

| File | Role |
|---|---|
| `content.js` | Runs on github.com. Finds diff lines, builds the context, renders the panel (in a shadow root). |
| `background.js` | Service worker. Finds the session for the PR's repo on ports 8790–8799, sends questions, streams replies. Content scripts can't call 127.0.0.1 from github.com, so all traffic goes through here. |
| `bridge.js` | The HTTP/SSE client, with no `chrome.*` calls. Tested from `channel-server/test/bridge.test.ts`. |
| `options.html` | Pairing token and the list of running sessions. |

## Known limits

- The ✦ line button relies on line-number cells (`data-line-number`) and file containers with a path attribute
  (`data-tagsearch-path`, `data-path`, or `data-file-path`). This was tested on GitHub's classic "Files changed"
  markup. If GitHub's newer diff view doesn't expose these, use text selection: it only needs the path.
- Answers arrive whole, not word by word.
- Questions to one session are handled one at a time.

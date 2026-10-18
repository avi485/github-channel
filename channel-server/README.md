# github-channel server

A [Claude Code channel](https://code.claude.com/docs/en/channels-reference) that lets the "Ask Claude" Chrome
extension send questions from a GitHub PR page into your running `claude` session, and get answers back.

```
Chrome extension ──HTTP/SSE on 127.0.0.1:8790-8799──▶ this server ──MCP stdio──▶ claude (in your local clone)
                 ◀────────── reply events ─────────── reply tool ◀──────────────
```

Claude Code starts one server per session. Each server binds the first free port in 8790–8799 and reports the
repo from the session's `origin` remote, so the extension can find the right session for the PR you're on.

## Setup

Requires [Bun](https://bun.sh) and Claude Code logged in with claude.ai or an API key. On a Team/Enterprise
account, an Owner must enable channels at **Organization settings → Claude Code → Channels**.

```bash
cd channel-server && bun install
```

Register the server once for all your repos (user scope, absolute path):

```bash
claude mcp add --scope user github-channel -- bun /Users/yeger/projects/github-channel/channel-server/src/server.ts
```

Then start Claude Code in the repo you're reviewing. Custom channels aren't on Anthropic's allowlist yet, so
this shows a warning screen to confirm:

```bash
claude --dangerously-load-development-channels server:github-channel
```

Optionally pre-approve read-only git commands so a permission prompt doesn't block in the terminal while
you're in the browser. Add to `~/.claude/settings.json` (or the repo's `.claude/settings.json`):

```json
{
  "permissions": {
    "allow": ["Bash(git fetch:*)", "Bash(git show:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git merge-base:*)"]
  }
}
```

## HTTP API

Every request needs `Authorization: Bearer <token>`. The token is created on first run at
`~/.config/github-channel/token` (print it with `bun run token`). Requests with a browser `Origin` other than
`chrome-extension://…` are rejected, as are non-loopback `Host` headers.

| Endpoint | Purpose |
|---|---|
| `GET /info` | `{ name, instance, repo, port, cwd }`, used by the extension to discover sessions. `instance` changes when the server restarts, which resets reply ids |
| `POST /ask` | Sends a question into the session. Returns `202 { chat_id, message_id }`, or `409` if the PR is for a different repo |
| `GET /events?chat_id=owner/repo%2312` | SSE stream of `reply` events. Send `Last-Event-ID` to replay missed replies |

`POST /ask` body:

```json
{
  "repo": "owner/repo", "pr": 12, "question": "Why is this loop unbounded?",
  "head_sha": "abc1234", "base_sha": "def5678",
  "path": "src/retry.ts", "line_start": 10, "line_end": 14, "side": "RIGHT",
  "hunk": "+while (true) { retry() }"
}
```

Only `repo`, `pr` and `question` are required. One `chat_id` (`owner/repo#12`) is one PR, so a conversation
follows you across the whole PR.

## Try it with curl

With a session running (see Setup), in another terminal:

```bash
TOKEN=$(bun run --silent token)
curl -s -H "Authorization: Bearer $TOKEN" localhost:8790/info
curl -N -H "Authorization: Bearer $TOKEN" "localhost:8790/events?chat_id=owner/repo%2312" &
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' localhost:8790/ask \
  -d '{"repo":"owner/repo","pr":12,"question":"Summarize this PR"}'
```

Replace `owner/repo` with the session's repo from `/info`. The answer arrives on the `/events` stream.

## Environment variables

| Variable | Default | |
|---|---|---|
| `GITHUB_CHANNEL_PORT` | first free in 8790–8799 | Pin one port |
| `GITHUB_CHANNEL_REPO` | from `git remote get-url origin` | Override the session's repo. If neither is set, any repo is accepted |
| `GITHUB_CHANNEL_EXTENSION_ID` | any `chrome-extension://` origin | Only accept this extension |
| `GITHUB_CHANNEL_CONFIG_DIR` | `~/.config/github-channel` | Where the token lives |

## Development

```bash
bun test        # integration tests with a fake MCP client
bun run typecheck
```

Logs go to stderr, since stdout is the MCP transport. Run `claude --debug` to see them.

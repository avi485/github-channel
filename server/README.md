# github-channel service

A small local service behind the "Ask Claude" Chrome extension. Each GitHub PR gets its own Claude Code session,
running in your local clone of the repo, that remembers the conversation. Answers stream back to the extension.

```
Chrome extension ──HTTP/SSE on 127.0.0.1:8790──▶ this service ──▶ one claude process per PR (cwd = your clone)
                 ◀──── status / partial / reply ──────────────── claude -p --input-format stream-json
```

- **One session per PR.** The first question for a PR starts a long-running
  `claude -p --input-format stream-json` process; follow-ups go into the same process, so Claude remembers
  the conversation. Different PRs get separate sessions and run in parallel.
- **Resumable.** Each PR's session id is saved in `~/.config/github-channel/sessions.json`. If the process has
  ended (30 minutes idle, a timeout, or a service restart), the next question resumes it with `--resume`. If it
  can't be resumed, a new session starts.
- **New session.** The extension's **New session** button (`POST /session/reset`) ends the PR's session and
  forgets it; the next question starts fresh.
- **Read-only.** Claude gets `Read`, `Grep`, `Glob`, and read-only git commands. It runs with
  `--permission-mode dontAsk`, so anything else is refused rather than prompted. It reads the PR with
  `git fetch origin pull/N/head` and `git show`, and never touches your working tree.
- **Uses your normal Claude Code login.** If `ANTHROPIC_API_KEY` is set in the environment the service
  starts in, `claude -p` uses that key instead, so leave it unset to use your subscription.

## Run

Requires [Bun](https://bun.sh) and Claude Code (`claude` on your PATH, logged in).

```bash
cd server && bun install
bun start
```

On start it lists the clones it found. A clone is any folder up to two levels under `~/projects` whose `origin`
remote is on GitHub. Map other folders in `~/.config/github-channel/repos.json`:

```json
{ "owner/repo": "/path/to/clone" }
```

## HTTP API

Every request needs `Authorization: Bearer <token>`. The token is created on first run at
`~/.config/github-channel/token` (copy it with `pbcopy < ~/.config/github-channel/token`). Requests with a
browser `Origin` other than `chrome-extension://…` are rejected, as are non-loopback `Host` headers.

| Endpoint | Purpose |
|---|---|
| `GET /info?repo=owner/repo&pr=12` | `{ name, instance, repos, clone, session }`. `clone` is the local folder for `repo`, or null. `session` is the PR's saved session `{ session_id, created, updated, live }`, or null. `instance` changes when the service restarts, which resets event ids |
| `POST /ask` | Sends a question to the PR's session. Returns `202 { chat_id, message_id }`, or `404` if there's no local clone |
| `POST /session/reset` | `{ repo, pr }`: ends the PR's session and forgets it |
| `GET /events?chat_id=owner/repo%2312` | SSE stream of `status`, `partial`, `reply` and `error` events. Send `Last-Event-ID` to replay missed replies and errors |

`POST /ask` body (only `repo`, `pr` and `question` are required):

```json
{
  "repo": "owner/repo", "pr": 12, "question": "Why is this loop unbounded?",
  "head_sha": "abc1234", "base_sha": "def5678",
  "path": "src/retry.ts", "line_start": 10, "line_end": 14, "side": "RIGHT",
  "hunk": "+while (true) { retry() }"
}
```

Questions in the same chat (`owner/repo#12`) run one at a time; different PRs run in parallel.

These are ordinary Claude Code sessions, so they also appear in `claude --resume` in that clone. You can open a
PR's session in your terminal, but not while the service has it open: wait for it to go idle, or stop the service.

## Try it with curl

```bash
TOKEN=$(cat ~/.config/github-channel/token)
curl -N -H "Authorization: Bearer $TOKEN" "localhost:8790/events?chat_id=owner/repo%2312" &
curl -s -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' localhost:8790/ask \
  -d '{"repo":"owner/repo","pr":12,"question":"Summarize this PR"}'
```

## Environment variables

| Variable | Default | |
|---|---|---|
| `GITHUB_CHANNEL_PORT` | `8790` | The extension expects 8790 |
| `GITHUB_CHANNEL_ROOTS` | `~/projects` | Folders to scan for clones, colon-separated |
| `GITHUB_CHANNEL_MODEL` | Claude Code's default | Passed to `claude --model` |
| `GITHUB_CHANNEL_TIMEOUT_MS` | `600000` (10 min) | Per question. On timeout the process ends; the session resumes on the next question |
| `GITHUB_CHANNEL_IDLE_MS` | `1800000` (30 min) | A PR's process ends after this long without questions |
| `GITHUB_CHANNEL_CLAUDE_BIN` | `claude` | Used by the tests to run a fake |
| `GITHUB_CHANNEL_EXTENSION_ID` | any `chrome-extension://` origin | Only accept this extension |
| `GITHUB_CHANNEL_CONFIG_DIR` | `~/.config/github-channel` | Token, `repos.json` and `sessions.json` |

## Development

```bash
bun test          # service and extension network code, with a fake claude
bun run typecheck
```

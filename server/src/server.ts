#!/usr/bin/env bun
/**
 * github-channel service: answers questions from the "Ask Claude" Chrome extension
 * by running `claude -p` in your local clone of the PR's repo.
 */
import { buildPrompt, runClaude } from "./claude.ts";
import { loadOrCreateToken, PORT, SCAN_ROOTS, TIMEOUT_MS } from "./config.ts";
import { type Ask, createFetchHandler, EventHub } from "./http.ts";
import { RepoIndex } from "./repos.ts";

const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

const token = await loadOrCreateToken();
const hub = new EventHub();
const repos = new RepoIndex(SCAN_ROOTS);
await repos.scan();

// Questions in one chat run in order, so answers arrive in the order they were asked.
const chatQueues = new Map<string, Promise<void>>();

async function answer(ask: Ask, cwd: string) {
  const started = Date.now();
  log(`ask ${ask.message_id} ${ask.chat_id} in ${cwd}`);
  try {
    const text = await runClaude(
      cwd,
      buildPrompt(ask),
      {
        onPartial: (t) => hub.publish("partial", ask.chat_id, ask.message_id, t),
        onStatus: (t) => hub.publish("status", ask.chat_id, ask.message_id, t),
      },
      { timeoutMs: TIMEOUT_MS },
    );
    hub.publish("reply", ask.chat_id, ask.message_id, text);
    log(`done ${ask.message_id} in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    hub.publish("error", ask.chat_id, ask.message_id, message);
    log(`failed ${ask.message_id}: ${message}`);
  }
}

function start(ask: Ask, cwd: string) {
  const previous = chatQueues.get(ask.chat_id) ?? Promise.resolve();
  const next = previous.then(() => answer(ask, cwd));
  chatQueues.set(ask.chat_id, next);
  next.finally(() => chatQueues.get(ask.chat_id) === next && chatQueues.delete(ask.chat_id));
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0, // SSE connections stay open indefinitely.
  fetch: createFetchHandler({
    token,
    instance: crypto.randomUUID(),
    hub,
    repos: () => repos.list(),
    findClone: (repo) => repos.find(repo),
    start,
  }),
});

log(`listening on http://127.0.0.1:${server.port}`);
log(`found ${repos.list().length} clones under ${SCAN_ROOTS.join(", ")}: ${repos.list().join(", ") || "(none)"}`);

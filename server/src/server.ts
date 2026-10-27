#!/usr/bin/env bun
/**
 * github-channel service: answers questions from the "Ask Claude" Chrome extension.
 * Each PR chat gets its own long-running Claude Code session in your local clone of
 * the repo, which remembers the conversation and resumes after restarts.
 */
import { loadOrCreateToken, PORT, SCAN_ROOTS } from "./config.ts";
import { type Ask, createFetchHandler, EventHub } from "./http.ts";
import { RepoIndex } from "./repos.ts";
import { SessionManager } from "./sessions.ts";

const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

const token = await loadOrCreateToken();
const hub = new EventHub();
const repos = new RepoIndex(SCAN_ROOTS);
await repos.scan();
const sessions = new SessionManager();

// Questions in one chat run in order, so answers arrive in the order they were asked.
const chatQueues = new Map<string, Promise<void>>();

async function answer(ask: Ask, cwd: string) {
  const started = Date.now();
  log(`ask ${ask.message_id} ${ask.chat_id} in ${cwd}`);
  try {
    const text = await sessions.ask(ask, cwd, {
      onPartial: (t) => hub.publish("partial", ask.chat_id, ask.message_id, t),
      onStatus: (t) => hub.publish("status", ask.chat_id, ask.message_id, t),
    });
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
    sessionInfo: (chatId) => sessions.info(chatId),
    resetSession: async (chatId) => {
      log(`new session for ${chatId}`);
      await sessions.reset(chatId);
    },
  }),
});

// Let Claude Code save each session cleanly on Ctrl+C.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    sessions.closeAll();
    setTimeout(() => process.exit(0), 500);
  });
}

log(`listening on http://127.0.0.1:${server.port}`);
log(`found ${repos.list().length} clones under ${SCAN_ROOTS.join(", ")}: ${repos.list().join(", ") || "(none)"}`);

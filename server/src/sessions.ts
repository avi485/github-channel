import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildPrompt, ClaudeSession, type TurnCallbacks } from "./claude.ts";
import { CONFIG_DIR, IDLE_MS, TIMEOUT_MS } from "./config.ts";
import type { Ask } from "./http.ts";

const SESSIONS_FILE = join(CONFIG_DIR, "sessions.json");

export type SavedSession = { session_id: string; cwd: string; created: string; updated: string };

/** chat id ("owner/repo#12") -> the Claude Code session that holds that PR's conversation. */
class SessionStore {
  private data: Record<string, SavedSession> = {};
  private loaded = false;

  private async load() {
    if (this.loaded) return;
    const file = Bun.file(SESSIONS_FILE);
    this.data = (await file.exists()) ? ((await file.json()) as Record<string, SavedSession>) : {};
    this.loaded = true;
  }

  private async write() {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
    await Bun.write(SESSIONS_FILE, JSON.stringify(this.data, null, 2) + "\n");
  }

  async get(chatId: string): Promise<SavedSession | undefined> {
    await this.load();
    return this.data[chatId];
  }

  async touch(chatId: string, sessionId: string, cwd: string) {
    await this.load();
    const now = new Date().toISOString();
    const existing = this.data[chatId];
    this.data[chatId] =
      existing?.session_id === sessionId
        ? { ...existing, updated: now }
        : { session_id: sessionId, cwd, created: now, updated: now };
    await this.write();
  }

  async forget(chatId: string) {
    await this.load();
    delete this.data[chatId];
    await this.write();
  }
}

/**
 * Keeps one live ClaudeSession per PR chat. A chat whose process has ended (idle,
 * service restart, timeout) is resumed from its saved session on the next question.
 */
export class SessionManager {
  private store = new SessionStore();
  private live = new Map<string, { session: ClaudeSession; cwd: string; idle?: Timer }>();

  async info(chatId: string): Promise<{ session_id: string; created: string; updated: string; live: boolean } | null> {
    const saved = await this.store.get(chatId);
    if (!saved) return null;
    return { session_id: saved.session_id, created: saved.created, updated: saved.updated, live: this.live.has(chatId) };
  }

  /** Answers one question in the chat's session. Callers run one question per chat at a time. */
  async ask(ask: Ask, cwd: string, callbacks: TurnCallbacks): Promise<string> {
    const prompt = buildPrompt(ask);
    let entry = this.live.get(ask.chat_id);
    if (entry && entry.cwd !== cwd) {
      entry.session.close();
      entry = undefined;
    }
    if (!entry) {
      const saved = await this.store.get(ask.chat_id);
      const resumeId = saved?.cwd === cwd ? saved.session_id : undefined;
      callbacks.onStatus(resumeId ? "Resuming this PR's session…" : "Starting a new session…");
      entry = this.start(ask.chat_id, cwd, resumeId);
    }
    clearTimeout(entry.idle);

    let text: string;
    try {
      text = await entry.session.ask(prompt, callbacks, TIMEOUT_MS);
    } catch (err) {
      if (!entry.session.failedToStart || !entry.session.resumeId) throw err;
      // The saved session couldn't be reopened (e.g. deleted). Start over rather than fail.
      await this.store.forget(ask.chat_id);
      callbacks.onStatus("Couldn't resume the previous session; starting a new one…");
      entry = this.start(ask.chat_id, cwd);
      text = await entry.session.ask(prompt, callbacks, TIMEOUT_MS);
    }
    if (entry.session.sessionId) await this.store.touch(ask.chat_id, entry.session.sessionId, cwd);
    this.scheduleIdle(ask.chat_id);
    return text;
  }

  /** "New session": ends the chat's process and forgets its saved session. */
  async reset(chatId: string) {
    this.live.get(chatId)?.session.kill();
    this.live.delete(chatId);
    await this.store.forget(chatId);
  }

  closeAll() {
    for (const { session } of this.live.values()) session.close();
  }

  private start(chatId: string, cwd: string, resumeId?: string) {
    const session = new ClaudeSession(cwd, resumeId);
    const entry = { session, cwd, idle: undefined as Timer | undefined };
    session.onSessionId = (id) => void this.store.touch(chatId, id, cwd);
    session.onExit = () => {
      if (this.live.get(chatId)?.session === session) this.live.delete(chatId);
    };
    this.live.set(chatId, entry);
    return entry;
  }

  /** Ends a quiet chat's process to free memory; its session resumes on the next question. */
  private scheduleIdle(chatId: string) {
    const entry = this.live.get(chatId);
    if (!entry) return;
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => entry.session.close(), IDLE_MS);
  }
}

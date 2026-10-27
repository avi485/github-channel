import { z } from "zod";

const Sha = z.string().regex(/^[0-9a-f]{7,40}$/i);

export const AskSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  pr: z.number().int().positive(),
  question: z.string().trim().min(1).max(8_000),
  head_sha: Sha.optional(),
  base_sha: Sha.optional(),
  path: z.string().max(1_000).optional(),
  line_start: z.number().int().positive().optional(),
  line_end: z.number().int().positive().optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  hunk: z.string().max(20_000).optional(),
});

const ChatRef = z.object({ repo: AskSchema.shape.repo, pr: AskSchema.shape.pr });
export type Ask = z.infer<typeof AskSchema> & { chat_id: string; message_id: string };

/**
 * Events for one question, keyed by message_id:
 * - status: what Claude is doing ("git show …"), not buffered
 * - partial: the answer so far, not buffered
 * - reply / error: the outcome, buffered for reconnects
 */
export type EventType = "status" | "partial" | "reply" | "error";
export type ChatEvent = { id: number; type: EventType; chat_id: string; message_id: string; text: string };

export function chatIdFor(repo: string, pr: number): string {
  return `${repo.toLowerCase()}#${pr}`;
}

/** Fans events out to SSE listeners and keeps outcomes for reconnects. */
export class EventHub {
  private nextId = 1;
  private buffer: ChatEvent[] = [];
  private listeners = new Set<{ chatId?: string; send: (e: ChatEvent) => void }>();

  constructor(private readonly bufferSize = 200) {}

  publish(type: EventType, chat_id: string, message_id: string, text: string): ChatEvent {
    const event: ChatEvent = { id: this.nextId++, type, chat_id, message_id, text };
    if (type === "reply" || type === "error") {
      this.buffer.push(event);
      if (this.buffer.length > this.bufferSize) this.buffer.shift();
    }
    for (const l of this.listeners) if (!l.chatId || l.chatId === chat_id) l.send(event);
    return event;
  }

  subscribe(chatId: string | undefined, sinceId: number, send: (e: ChatEvent) => void): () => void {
    for (const e of this.buffer) if (e.id > sinceId && (!chatId || e.chat_id === chatId)) send(e);
    const listener = { chatId, send };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export type HttpDeps = {
  token: string;
  /** Random per process; event ids restart at 1 when this changes. */
  instance: string;
  hub: EventHub;
  repos: () => string[];
  /** Local clone for a repo, or null. */
  findClone: (repo: string) => Promise<string | null>;
  /** Starts answering in the background; progress goes to the hub. */
  start: (ask: Ask, cwd: string) => void;
  /** The PR chat's saved session, if any. */
  sessionInfo: (chatId: string) => Promise<unknown>;
  /** Ends the PR chat's session; the next question starts a new one. */
  resetSession: (chatId: string) => Promise<void>;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * Rejects anything that isn't the extension (or a local tool like curl):
 * - Host must be loopback (defends against DNS rebinding).
 * - A browser Origin, if present, must be a chrome-extension:// origin,
 *   optionally pinned with GITHUB_CHANNEL_EXTENSION_ID.
 * - Bearer token must match.
 */
function checkRequest(req: Request, deps: HttpDeps): Response | null {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return json({ error: "bad host" }, 403);

  const origin = req.headers.get("origin");
  if (origin) {
    const pinned = process.env.GITHUB_CHANNEL_EXTENSION_ID;
    const ok = pinned ? origin === `chrome-extension://${pinned}` : origin.startsWith("chrome-extension://");
    if (!ok) return json({ error: "origin not allowed" }, 403);
  }

  const auth = req.headers.get("authorization") ?? "";
  const given = Buffer.from(auth.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(deps.token);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

export function createFetchHandler(deps: HttpDeps) {
  return async function fetch(req: Request): Promise<Response> {
    const rejected = checkRequest(req, deps);
    if (rejected) return rejected;

    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/info") {
      const repo = url.searchParams.get("repo");
      const pr = Number(url.searchParams.get("pr"));
      return json({
        name: "github-channel",
        instance: deps.instance,
        repos: deps.repos(),
        ...(repo ? { clone: await deps.findClone(repo) } : {}),
        ...(repo && pr ? { session: await deps.sessionInfo(chatIdFor(repo, pr)) } : {}),
      });
    }

    if (req.method === "POST" && url.pathname === "/session/reset") {
      const parsed = ChatRef.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return json({ error: "invalid request", issues: parsed.error.issues }, 400);
      await deps.resetSession(chatIdFor(parsed.data.repo, parsed.data.pr));
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/ask") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      const parsed = AskSchema.safeParse(body);
      if (!parsed.success) return json({ error: "invalid request", issues: parsed.error.issues }, 400);
      const cwd = await deps.findClone(parsed.data.repo);
      if (!cwd) return json({ error: `no local clone of ${parsed.data.repo} found` }, 404);
      const ask: Ask = {
        ...parsed.data,
        chat_id: chatIdFor(parsed.data.repo, parsed.data.pr),
        message_id: crypto.randomUUID().slice(0, 8),
      };
      deps.start(ask, cwd);
      return json({ ok: true, chat_id: ask.chat_id, message_id: ask.message_id }, 202);
    }

    if (req.method === "GET" && url.pathname === "/events") {
      const chatId = url.searchParams.get("chat_id") ?? undefined;
      const sinceId = Number(req.headers.get("last-event-id") ?? url.searchParams.get("since") ?? 0) || 0;
      return sseResponse(req, deps.hub, chatId, sinceId);
    }

    return json({ error: "not found" }, 404);
  };
}

function sseResponse(req: Request, hub: EventHub, chatId: string | undefined, sinceId: number): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => {
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          cleanup();
        }
      };
      write(": connected\n\n");
      const unsubscribe = hub.subscribe(chatId, sinceId, (e) => {
        write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      });
      const keepAlive = setInterval(() => write(": ping\n\n"), 15_000);
      cleanup = () => {
        clearInterval(keepAlive);
        unsubscribe();
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

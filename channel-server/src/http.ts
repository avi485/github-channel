import { z } from "zod";

export const AskSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  pr: z.number().int().positive(),
  question: z.string().trim().min(1).max(8_000),
  head_sha: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
  base_sha: z.string().regex(/^[0-9a-f]{7,40}$/i).optional(),
  path: z.string().max(1_000).optional(),
  line_start: z.number().int().positive().optional(),
  line_end: z.number().int().positive().optional(),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  hunk: z.string().max(20_000).optional(),
});
export type Ask = z.infer<typeof AskSchema> & { chat_id: string; message_id: string };

export type ReplyEvent = { id: number; chat_id: string; text: string; in_reply_to?: string };

export function chatIdFor(repo: string, pr: number): string {
  return `${repo.toLowerCase()}#${pr}`;
}

/** Fans replies out to SSE listeners and keeps a short buffer for reconnects. */
export class ReplyHub {
  private nextId = 1;
  private buffer: ReplyEvent[] = [];
  private listeners = new Set<{ chatId?: string; send: (e: ReplyEvent) => void }>();

  constructor(private readonly bufferSize = 200) {}

  publish(chat_id: string, text: string, in_reply_to?: string): { event: ReplyEvent; delivered: number } {
    const event: ReplyEvent = { id: this.nextId++, chat_id, text, in_reply_to };
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    let delivered = 0;
    for (const l of this.listeners) {
      if (!l.chatId || l.chatId === chat_id) {
        l.send(event);
        delivered++;
      }
    }
    return { event, delivered };
  }

  subscribe(chatId: string | undefined, sinceId: number, send: (e: ReplyEvent) => void): () => void {
    for (const e of this.buffer) if (e.id > sinceId && (!chatId || e.chat_id === chatId)) send(e);
    const listener = { chatId, send };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export type HttpDeps = {
  token: string;
  /** Random per process; reply ids restart at 1 when this changes. */
  instance: string;
  repo: string | null;
  port: () => number;
  hub: ReplyHub;
  /** Pushes the question into the Claude Code session. */
  deliver: (ask: Ask) => Promise<void>;
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
      return json({ name: "github-channel", instance: deps.instance, repo: deps.repo, port: deps.port(), cwd: process.cwd() });
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
      if (deps.repo && parsed.data.repo.toLowerCase() !== deps.repo) {
        return json({ error: `this session is for ${deps.repo}` }, 409);
      }
      const ask: Ask = {
        ...parsed.data,
        chat_id: chatIdFor(parsed.data.repo, parsed.data.pr),
        message_id: crypto.randomUUID().slice(0, 8),
      };
      await deps.deliver(ask);
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

function sseResponse(req: Request, hub: ReplyHub, chatId: string | undefined, sinceId: number): Response {
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
        write(`id: ${e.id}\nevent: reply\ndata: ${JSON.stringify(e)}\n\n`);
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

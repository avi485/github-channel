// Talks to github-channel servers on 127.0.0.1. No chrome.* APIs here, so it can
// be tested with Bun against a real server.

export const PORTS = Array.from({ length: 10 }, (_, i) => 8790 + i);

const base = (port) => `http://127.0.0.1:${port}`;
const authHeaders = (token) => ({ authorization: `Bearer ${token}` });

/** Returns the server's /info, or null if nothing (or something else) answers. */
export async function probe(port, token, timeoutMs = 800) {
  try {
    const res = await fetch(`${base(port)}/info`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) return { port, unauthorized: true };
    if (!res.ok) return null;
    const info = await res.json();
    return info?.name === "github-channel" ? { ...info, port } : null;
  } catch {
    return null;
  }
}

export async function listSessions(token, ports = PORTS) {
  const results = await Promise.all(ports.map((p) => probe(p, token)));
  return results.filter(Boolean);
}

/**
 * Finds the session for a repo. A session whose repo matches wins; a session
 * with no detected repo (repo: null) accepts anything and is the fallback.
 */
export async function findSession(repo, token, ports = PORTS) {
  const sessions = await listSessions(token, ports);
  const wanted = repo.toLowerCase();
  const usable = sessions.filter((s) => !s.unauthorized);
  return (
    usable.find((s) => s.repo === wanted) ??
    usable.find((s) => s.repo == null) ??
    (sessions.some((s) => s.unauthorized) ? { unauthorized: true } : null)
  );
}

export async function ask(port, token, payload) {
  const res = await fetch(`${base(port)}/ask`, {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/**
 * Streams reply events for a chat until the connection ends or `signal` aborts.
 * Calls onEvent({ id, chat_id, text, in_reply_to }) for each reply.
 */
export async function streamReplies({ port, token, chatId, lastEventId = 0, signal, onEvent }) {
  const res = await fetch(`${base(port)}/events?chat_id=${encodeURIComponent(chatId)}`, {
    headers: { ...authHeaders(token), "last-event-id": String(lastEventId) },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`events: HTTP ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = parseSseBlock(block);
      if (event?.type === "reply") onEvent(JSON.parse(event.data));
    }
  }
}

export function parseSseBlock(block) {
  let type = "message";
  const data = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") type = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { type, data: data.join("\n") } : null;
}

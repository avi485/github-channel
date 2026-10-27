// Talks to the github-channel service on 127.0.0.1. No chrome.* APIs here, so it
// can be tested with Bun against a real server.

export const DEFAULT_PORT = 8790;

const base = (port) => `http://127.0.0.1:${port}`;
const authHeaders = (token) => ({ authorization: `Bearer ${token}` });

/**
 * Checks the service, whether it has a clone of `repo`, and the PR's saved session.
 * Returns { state: "ok" | "no-service" | "bad-token" | "no-clone", ...info }.
 */
export async function getStatus(token, repo, pr, port = DEFAULT_PORT) {
  try {
    const params = new URLSearchParams();
    if (repo) params.set("repo", repo);
    if (pr) params.set("pr", String(pr));
    const query = params.size ? `?${params}` : "";
    const res = await fetch(`${base(port)}/info${query}`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(2000),
    });
    if (res.status === 401) return { state: "bad-token", port };
    if (!res.ok) return { state: "no-service", port };
    const info = await res.json();
    if (info?.name !== "github-channel") return { state: "no-service", port };
    return { ...info, port, state: repo && !info.clone ? "no-clone" : "ok" };
  } catch {
    return { state: "no-service", port };
  }
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

/** Ends the PR's Claude session; its next question starts a new one. */
export async function resetSession(port, token, repo, pr) {
  const res = await fetch(`${base(port)}/session/reset`, {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ repo, pr }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

/**
 * Streams a chat's events until the connection ends or `signal` aborts.
 * Calls onEvent({ id, type, chat_id, message_id, text }) where type is
 * "status" | "partial" | "reply" | "error".
 */
export async function streamEvents({ port, token, chatId, lastEventId = 0, signal, onEvent }) {
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
      if (event) onEvent(JSON.parse(event.data));
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

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseGitHubRepo } from "../src/config.ts";

const PORT = 18790;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token-123";
let client: Client;
const notifications: { method: string; params?: Record<string, unknown> }[] = [];

beforeAll(async () => {
  const configDir = await mkdtemp(join(tmpdir(), "github-channel-test-"));
  await Bun.write(join(configDir, "token"), TOKEN);
  client = new Client({ name: "fake-claude-code", version: "0" });
  client.fallbackNotificationHandler = async (n) => {
    notifications.push(n as (typeof notifications)[number]);
  };
  await client.connect(
    new StdioClientTransport({
      command: "bun",
      args: [join(import.meta.dir, "../src/server.ts")],
      env: {
        ...(process.env as Record<string, string>),
        GITHUB_CHANNEL_CONFIG_DIR: configDir,
        GITHUB_CHANNEL_PORT: String(PORT),
        GITHUB_CHANNEL_REPO: "Acme/Widgets",
      },
      stderr: "ignore",
    }),
  );
  // Wait for the HTTP listener.
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/info`);
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
});

afterAll(async () => {
  await client.close();
});

const auth = { authorization: `Bearer ${TOKEN}` };

test("declares the channel capability and instructions", () => {
  expect(client.getServerCapabilities()?.experimental?.["claude/channel"]).toEqual({});
  expect(client.getInstructions()).toContain("reply");
});

test("rejects requests without the token, from web origins, or with a non-loopback Host", async () => {
  expect((await fetch(`${BASE}/info`)).status).toBe(401);
  expect((await fetch(`${BASE}/info`, { headers: { ...auth, origin: "https://github.com" } })).status).toBe(403);
  expect((await fetch(`${BASE}/info`, { headers: { ...auth, host: "evil.example" } })).status).toBe(403);
  expect((await fetch(`${BASE}/info`, { headers: { ...auth, origin: "chrome-extension://abc" } })).status).toBe(200);
});

test("/info reports the session's repo", async () => {
  const info = (await (await fetch(`${BASE}/info`, { headers: auth })).json()) as Record<string, unknown>;
  expect(info).toMatchObject({ name: "github-channel", repo: "acme/widgets", port: PORT });
  expect(info.instance).toBeString();
});

test("/ask validates input and checks the repo", async () => {
  const post = (body: unknown) =>
    fetch(`${BASE}/ask`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post({ repo: "acme/widgets", pr: 1 })).status).toBe(400);
  expect((await post({ repo: "other/repo", pr: 1, question: "hi" })).status).toBe(409);
});

test("an ask becomes a channel notification, and a reply reaches the SSE stream", async () => {
  const chatId = "acme/widgets#42";
  const sse = await fetch(`${BASE}/events?chat_id=${encodeURIComponent(chatId)}`, { headers: auth });
  const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader();

  const res = await fetch(`${BASE}/ask`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      repo: "acme/widgets",
      pr: 42,
      question: "Why is this retry loop unbounded?",
      head_sha: "abc1234",
      path: "src/retry.ts",
      line_start: 10,
      line_end: 14,
      side: "RIGHT",
      hunk: "+while (true) { retry() }",
    }),
  });
  expect(res.status).toBe(202);
  const { chat_id, message_id } = (await res.json()) as { chat_id: string; message_id: string };
  expect(chat_id).toBe(chatId);

  for (let i = 0; i < 50 && notifications.length === 0; i++) await Bun.sleep(20);
  const n = notifications.at(-1)!;
  expect(n.method).toBe("notifications/claude/channel");
  expect(n.params?.content).toContain("Why is this retry loop unbounded?");
  expect(n.params?.content).toContain("<untrusted_diff>");
  expect(n.params?.meta).toMatchObject({ chat_id: chatId, pr: "42", path: "src/retry.ts", line_start: "10", side: "RIGHT", message_id });

  const result = await client.callTool({ name: "reply", arguments: { chat_id: chatId, text: "It is bounded by `maxAttempts`.", in_reply_to: message_id } });
  expect((result.content as { text: string }[])[0]!.text).toBe("sent");

  let received = "";
  while (!received.includes("event: reply")) received += (await reader.read()).value ?? "";
  expect(received).toContain("It is bounded by `maxAttempts`.");
  await reader.cancel();
});

test("replies sent while disconnected are replayed with Last-Event-ID", async () => {
  await client.callTool({ name: "reply", arguments: { chat_id: "acme/widgets#7", text: "late answer" } });
  const sse = await fetch(`${BASE}/events?chat_id=${encodeURIComponent("acme/widgets#7")}`, {
    headers: { ...auth, "last-event-id": "0" },
  });
  const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader();
  let received = "";
  while (!received.includes("late answer")) received += (await reader.read()).value ?? "";
  await reader.cancel();
});

test("parses GitHub remotes", () => {
  expect(parseGitHubRepo("git@github.com:Acme/Widgets.git")).toBe("acme/widgets");
  expect(parseGitHubRepo("https://github.com/acme/widgets")).toBe("acme/widgets");
  expect(parseGitHubRepo("https://gitlab.com/acme/widgets.git")).toBeNull();
});

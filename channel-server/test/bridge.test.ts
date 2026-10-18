// Tests the extension's network code (extension/bridge.js) against a real server.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ask, findSession, listSessions, parseSseBlock, streamReplies } from "../../extension/bridge.js";

const PORT = 18792;
const PORTS = [PORT, PORT + 1];
const TOKEN = "bridge-token";
let client: Client;

beforeAll(async () => {
  const configDir = await mkdtemp(join(tmpdir(), "github-channel-bridge-"));
  await Bun.write(join(configDir, "token"), TOKEN);
  client = new Client({ name: "fake-claude-code", version: "0" });
  client.fallbackNotificationHandler = async () => {};
  await client.connect(
    new StdioClientTransport({
      command: "bun",
      args: [join(import.meta.dir, "../src/server.ts")],
      env: {
        ...(process.env as Record<string, string>),
        GITHUB_CHANNEL_CONFIG_DIR: configDir,
        GITHUB_CHANNEL_PORT: String(PORT),
        GITHUB_CHANNEL_REPO: "acme/widgets",
      },
      stderr: "ignore",
    }),
  );
  for (let i = 0; i < 50 && !(await listSessions(TOKEN, PORTS)).length; i++) await Bun.sleep(50);
});

afterAll(async () => {
  await client.close();
});

test("finds the session for a repo, and reports a wrong token", async () => {
  const session = await findSession("Acme/Widgets", TOKEN, PORTS);
  expect(session).toMatchObject({ port: PORT, repo: "acme/widgets" });
  expect(await findSession("other/repo", TOKEN, PORTS)).toBeNull();
  expect(await findSession("acme/widgets", "wrong", PORTS)).toEqual({ unauthorized: true });
});

test("asks and streams the reply", async () => {
  const controller = new AbortController();
  const events: { text: string }[] = [];
  const streaming = streamReplies({
    port: PORT,
    token: TOKEN,
    chatId: "acme/widgets#9",
    signal: controller.signal,
    onEvent: (e: { text: string }) => events.push(e),
  }).catch(() => {});

  const result = (await ask(PORT, TOKEN, { repo: "acme/widgets", pr: 9, question: "hi" })) as { chat_id: string };
  expect(result.chat_id).toBe("acme/widgets#9");
  await expect(ask(PORT, TOKEN, { repo: "acme/widgets", pr: 9 })).rejects.toThrow("invalid request");

  await client.callTool({ name: "reply", arguments: { chat_id: "acme/widgets#9", text: "line one\nline two" } });
  for (let i = 0; i < 50 && !events.length; i++) await Bun.sleep(20);
  expect(events[0]?.text).toBe("line one\nline two");
  controller.abort();
  await streaming;
});

test("parses SSE blocks", () => {
  expect(parseSseBlock(": ping")).toBeNull();
  expect(parseSseBlock('id: 3\nevent: reply\ndata: {"a":1}')).toEqual({ type: "reply", data: '{"a":1}' });
});

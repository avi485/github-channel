// Tests the extension's network code (extension/bridge.js) against the real service.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ask, getStatus, parseSseBlock, streamEvents } from "../../extension/bridge.js";
import { startServer, TOKEN, type TestServer } from "./helpers.ts";

let server: TestServer;

beforeAll(async () => {
  server = await startServer(18792);
});

afterAll(() => server.stop());

test("reports service and clone status", async () => {
  expect(await getStatus(TOKEN, "Acme/Widgets", server.port)).toMatchObject({ state: "ok", clone: server.clone });
  expect(await getStatus(TOKEN, "other/repo", server.port)).toMatchObject({ state: "no-clone" });
  expect(await getStatus("wrong", "acme/widgets", server.port)).toMatchObject({ state: "bad-token" });
  expect(await getStatus(TOKEN, "acme/widgets", 18799)).toMatchObject({ state: "no-service" });
});

test("asks and streams status, partial and reply events", async () => {
  const controller = new AbortController();
  const events: { type: string; text: string }[] = [];
  const streaming = streamEvents({
    port: server.port,
    token: TOKEN,
    chatId: "acme/widgets#9",
    signal: controller.signal,
    onEvent: (e: { type: string; text: string }) => events.push(e),
  }).catch(() => {});

  const result = (await ask(server.port, TOKEN, { repo: "acme/widgets", pr: 9, question: "hi", history: [] })) as {
    chat_id: string;
  };
  expect(result.chat_id).toBe("acme/widgets#9");
  await expect(ask(server.port, TOKEN, { repo: "acme/widgets", pr: 9 })).rejects.toThrow("invalid request");

  for (let i = 0; i < 100 && !events.some((e) => e.type === "reply"); i++) await Bun.sleep(50);
  expect(events.map((e) => e.type)).toContain("status");
  expect(events.map((e) => e.type)).toContain("partial");
  expect(events.at(-1)).toMatchObject({ type: "reply", text: "The answer is 42." });
  controller.abort();
  await streaming;
});

test("parses SSE blocks", () => {
  expect(parseSseBlock(": ping")).toBeNull();
  expect(parseSseBlock('id: 3\nevent: reply\ndata: {"a":1}')).toEqual({ type: "reply", data: '{"a":1}' });
});

// Tests the extension's network code (extension/bridge.js) against the real service.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ask, getStatus, parseSseBlock, resetSession, streamEvents } from "../../extension/bridge.js";
import { createFixture, type Fixture, startServer, TOKEN, type TestServer } from "./helpers.ts";

let f: Fixture;
let server: TestServer;

beforeAll(async () => {
  f = await createFixture();
  server = await startServer(f, 18792);
});

afterAll(() => server.stop());

test("reports service, clone and session status", async () => {
  expect(await getStatus(TOKEN, "Acme/Widgets", 9, server.port)).toMatchObject({ state: "ok", clone: f.clone, session: null });
  expect(await getStatus(TOKEN, "other/repo", 9, server.port)).toMatchObject({ state: "no-clone" });
  expect(await getStatus("wrong", "acme/widgets", 9, server.port)).toMatchObject({ state: "bad-token" });
  expect(await getStatus(TOKEN, "acme/widgets", 9, 18799)).toMatchObject({ state: "no-service" });
});

test("asks, streams events, and resets the session", async () => {
  const controller = new AbortController();
  const events: { type: string; text: string }[] = [];
  const streaming = streamEvents({
    port: server.port,
    token: TOKEN,
    chatId: "acme/widgets#9",
    signal: controller.signal,
    onEvent: (e: { type: string; text: string }) => events.push(e),
  }).catch(() => {});

  const result = (await ask(server.port, TOKEN, { repo: "acme/widgets", pr: 9, question: "hi" })) as { chat_id: string };
  expect(result.chat_id).toBe("acme/widgets#9");
  await expect(ask(server.port, TOKEN, { repo: "acme/widgets", pr: 9 })).rejects.toThrow("invalid request");

  for (let i = 0; i < 100 && !events.some((e) => e.type === "reply"); i++) await Bun.sleep(50);
  expect(events.map((e) => e.type)).toContain("status");
  expect(events.map((e) => e.type)).toContain("partial");
  expect(events.at(-1)).toMatchObject({ type: "reply" });
  expect(events.at(-1)!.text).toStartWith("Answer 1 in ");
  controller.abort();
  await streaming;

  const sessionOf = async () => ((await getStatus(TOKEN, "acme/widgets", 9, server.port)) as { session?: unknown }).session;
  expect(await sessionOf()).toMatchObject({ live: true });
  await resetSession(server.port, TOKEN, "acme/widgets", 9);
  expect(await sessionOf()).toBeNull();
});

test("parses SSE blocks", () => {
  expect(parseSseBlock(": ping")).toBeNull();
  expect(parseSseBlock('id: 3\nevent: reply\ndata: {"a":1}')).toEqual({ type: "reply", data: '{"a":1}' });
});

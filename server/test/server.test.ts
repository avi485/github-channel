import { afterAll, beforeAll, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { parseGitHubRepo } from "../src/config.ts";
import { auth, readUntil, startServer, type TestServer } from "./helpers.ts";

let server: TestServer;
let failing: TestServer;

beforeAll(async () => {
  server = await startServer(18790);
  failing = await startServer(18791, { FAKE_CLAUDE_MODE: "fail" });
});

afterAll(() => {
  server.stop();
  failing.stop();
});

const post = (base: string, body: unknown) =>
  fetch(`${base}/ask`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

test("rejects requests without the token, from web origins, or with a non-loopback Host", async () => {
  expect((await fetch(`${server.base}/info`)).status).toBe(401);
  expect((await fetch(`${server.base}/info`, { headers: { ...auth, origin: "https://github.com" } })).status).toBe(403);
  expect((await fetch(`${server.base}/info`, { headers: { ...auth, host: "evil.example" } })).status).toBe(403);
  expect((await fetch(`${server.base}/info`, { headers: { ...auth, origin: "chrome-extension://abc" } })).status).toBe(200);
});

test("/info lists configured and scanned clones", async () => {
  const info = (await (await fetch(`${server.base}/info?repo=acme/widgets`, { headers: auth })).json()) as Record<string, unknown>;
  expect(info.repos).toEqual(["acme/scanned", "acme/widgets"]);
  expect(info.clone).toBe(server.clone);
  expect(info.instance).toBeString();
});

test("/ask validates input and needs a clone", async () => {
  expect((await post(server.base, { repo: "acme/widgets", pr: 1 })).status).toBe(400);
  expect((await post(server.base, { repo: "other/repo", pr: 1, question: "hi" })).status).toBe(404);
});

test("runs claude in the clone with history, streams progress, then replies", async () => {
  const chatId = "acme/widgets#42";
  const sse = await fetch(`${server.base}/events?chat_id=${encodeURIComponent(chatId)}`, { headers: auth });
  const res = await post(server.base, {
    repo: "acme/widgets",
    pr: 42,
    question: "Why is this retry loop unbounded?",
    path: "src/retry.ts",
    line_start: 10,
    side: "RIGHT",
    hunk: "+while (true) { retry() }",
    history: [
      { role: "user", text: "What does this PR do?" },
      { role: "assistant", text: "It adds retries." },
    ],
  });
  expect(res.status).toBe(202);
  const { message_id } = (await res.json()) as { message_id: string };

  const text = await readUntil(sse, (t) => t.includes("event: reply"));
  expect(text).toContain("event: status");
  expect(text).toContain("git show abc:src/a.ts");
  expect(text).toContain("event: partial");
  expect(text).toContain('"text":"The answer is 42."');
  expect(text).toContain(`"message_id":"${message_id}"`);

  const call = JSON.parse(await Bun.file(server.logFile).text());
  expect(await realpath(call.cwd)).toBe(await realpath(server.clone));
  expect(call.args).toContain("-p");
  expect(call.args.join(" ")).toContain("--permission-mode dontAsk");
  expect(call.args).toContain("--no-session-persistence");
  expect(call.prompt).toContain("Pull request: acme/widgets#42");
  expect(call.prompt).toContain("<conversation_so_far>\n[user]\nWhat does this PR do?\n\n[assistant]\nIt adds retries.");
  expect(call.prompt).toContain("Question:\nWhy is this retry loop unbounded?");
  expect(call.prompt).toContain("Context: src/retry.ts line 10 (new side)");
  expect(call.prompt).toContain("<untrusted_diff>\n+while (true) { retry() }\n</untrusted_diff>");
});

test("a question without history has no conversation block", async () => {
  const sse = await fetch(`${server.base}/events?chat_id=${encodeURIComponent("acme/widgets#43")}`, { headers: auth });
  await post(server.base, { repo: "acme/widgets", pr: 43, question: "First question" });
  await readUntil(sse, (t) => t.includes("event: reply"));
  const call = JSON.parse(await Bun.file(server.logFile).text());
  expect(call.prompt).not.toContain("<conversation_so_far>");
});

test("a failed run becomes an error event, replayed with Last-Event-ID", async () => {
  const chatId = "acme/widgets#7";
  await post(failing.base, { repo: "acme/widgets", pr: 7, question: "hi" });
  await Bun.sleep(1000);
  const sse = await fetch(`${failing.base}/events?chat_id=${encodeURIComponent(chatId)}`, {
    headers: { ...auth, "last-event-id": "0" },
  });
  const text = await readUntil(sse, (t) => t.includes("event: error"));
  expect(text).toContain("something went wrong");
});

test("parses GitHub remotes", () => {
  expect(parseGitHubRepo("git@github.com:Acme/Widgets.git")).toBe("acme/widgets");
  expect(parseGitHubRepo("https://github.com/acme/widgets")).toBe("acme/widgets");
  expect(parseGitHubRepo("https://gitlab.com/acme/widgets.git")).toBeNull();
});

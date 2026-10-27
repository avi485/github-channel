import { afterAll, beforeAll, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseGitHubRepo } from "../src/config.ts";
import { askAndWait, auth, claudeCalls, createFixture, type Fixture, post, startServer, type TestServer } from "./helpers.ts";

let f: Fixture;
let server: TestServer;

beforeAll(async () => {
  f = await createFixture();
  server = await startServer(f, 18790);
});

afterAll(async () => {
  await server.stop();
});

const sessionIdOf = (answer: string) => answer.split(" in ")[1];

test("rejects requests without the token, from web origins, or with a non-loopback Host", async () => {
  expect((await fetch(`${server.base}/info`)).status).toBe(401);
  expect((await fetch(`${server.base}/info`, { headers: { ...auth, origin: "https://github.com" } })).status).toBe(403);
  expect((await fetch(`${server.base}/info`, { headers: { ...auth, host: "evil.example" } })).status).toBe(403);
  expect((await fetch(`${server.base}/info`, { headers: { ...auth, origin: "chrome-extension://abc" } })).status).toBe(200);
});

test("/info lists configured and scanned clones", async () => {
  const info = (await (await fetch(`${server.base}/info?repo=acme/widgets`, { headers: auth })).json()) as Record<string, unknown>;
  expect(info.repos).toEqual(["acme/scanned", "acme/widgets"]);
  expect(info.clone).toBe(f.clone);
  expect(info.instance).toBeString();
});

test("/ask validates input and needs a clone", async () => {
  expect((await post(server.base, "/ask", { repo: "acme/widgets", pr: 1 })).status).toBe(400);
  expect((await post(server.base, "/ask", { repo: "other/repo", pr: 1, question: "hi" })).status).toBe(404);
});

test("a PR keeps one session across questions, and streams progress", async () => {
  const first = await askAndWait(server.base, {
    repo: "acme/widgets",
    pr: 42,
    question: "Why is this retry loop unbounded?",
    path: "src/retry.ts",
    line_start: 10,
    side: "RIGHT",
    hunk: "+while (true) { retry() }",
  });
  expect(first.type).toBe("reply");
  expect(first.text).toStartWith("Answer 1 in ");
  const types = first.events.map((e) => e.type);
  expect(types).toContain("status");
  expect(types).toContain("partial");
  expect(first.events.find((e) => e.type === "status")?.text).toBe("Starting a new session…");

  const second = await askAndWait(server.base, { repo: "acme/widgets", pr: 42, question: "And the follow-up?" });
  expect(second.text).toBe(`Answer 2 in ${sessionIdOf(first.text)}`);

  const calls = (await claudeCalls(f)).filter((c) => c.prompt.includes("acme/widgets#42"));
  expect(calls).toHaveLength(2);
  expect(await realpath(calls[0]!.cwd)).toBe(await realpath(f.clone));
  expect(calls[0]!.args.join(" ")).toContain("--input-format stream-json");
  expect(calls[0]!.args.join(" ")).toContain("--permission-mode dontAsk");
  expect(calls[0]!.args).not.toContain("--no-session-persistence");
  expect(calls[0]!.prompt).toContain("Question:\nWhy is this retry loop unbounded?");
  expect(calls[0]!.prompt).toContain("Context: src/retry.ts line 10 (new side)");
  expect(calls[0]!.prompt).toContain("<untrusted_diff>\n+while (true) { retry() }\n</untrusted_diff>");
  expect(calls[1]!.prompt).not.toContain("<untrusted_diff>");

  const info = (await (await fetch(`${server.base}/info?repo=acme/widgets&pr=42`, { headers: auth })).json()) as {
    session: { session_id: string; live: boolean };
  };
  expect(info.session).toMatchObject({ session_id: sessionIdOf(first.text), live: true });
});

test("other PRs get their own sessions", async () => {
  const a = await askAndWait(server.base, { repo: "acme/widgets", pr: 50, question: "hi" });
  const b = await askAndWait(server.base, { repo: "acme/widgets", pr: 51, question: "hi" });
  expect(a.text).toStartWith("Answer 1 in ");
  expect(b.text).toStartWith("Answer 1 in ");
  expect(sessionIdOf(a.text)).not.toBe(sessionIdOf(b.text));
});

test("New session forgets the PR's session", async () => {
  const before = await askAndWait(server.base, { repo: "acme/widgets", pr: 60, question: "hi" });
  expect((await post(server.base, "/session/reset", { repo: "acme/widgets", pr: 60 })).status).toBe(200);
  const info = (await (await fetch(`${server.base}/info?repo=acme/widgets&pr=60`, { headers: auth })).json()) as {
    session: unknown;
  };
  expect(info.session).toBeNull();
  const after = await askAndWait(server.base, { repo: "acme/widgets", pr: 60, question: "hi again" });
  expect(after.text).toStartWith("Answer 1 in ");
  expect(sessionIdOf(after.text)).not.toBe(sessionIdOf(before.text));
});

test("after a restart, a PR resumes its saved session", async () => {
  const before = await askAndWait(server.base, { repo: "acme/widgets", pr: 70, question: "hi" });
  await server.stop();
  server = await startServer(f, 18790);
  const after = await askAndWait(server.base, { repo: "acme/widgets", pr: 70, question: "remember me?" });
  expect(after.text).toBe(`Answer 2 in ${sessionIdOf(before.text)}`);
  expect(after.events.find((e) => e.type === "status")?.text).toBe("Resuming this PR's session…");
  const last = (await claudeCalls(f)).at(-1)!;
  expect(last.resumeId).toBe(sessionIdOf(before.text));
});

test("a session that can't be resumed is replaced by a new one", async () => {
  const sessionsFile = join(f.configDir, "sessions.json");
  const sessions = await Bun.file(sessionsFile).json();
  sessions["acme/widgets#80"] = { session_id: "missing-1", cwd: f.clone, created: "2026-01-01T00:00:00Z", updated: "2026-01-01T00:00:00Z" };
  await Bun.write(sessionsFile, JSON.stringify(sessions));
  await server.stop();
  server = await startServer(f, 18790);
  const answer = await askAndWait(server.base, { repo: "acme/widgets", pr: 80, question: "hi" });
  expect(answer.type).toBe("reply");
  expect(answer.text).toStartWith("Answer 1 in ");
  expect(answer.events.map((e) => e.text)).toContain("Couldn't resume the previous session; starting a new one…");
});

test("a failed run becomes an error event, replayed with Last-Event-ID", async () => {
  const failing = await startServer(f, 18791, { FAKE_CLAUDE_MODE: "fail" });
  try {
    await post(failing.base, "/ask", { repo: "acme/widgets", pr: 7, question: "hi" });
    await Bun.sleep(1000);
    const sse = await fetch(`${failing.base}/events?chat_id=${encodeURIComponent("acme/widgets#7")}`, {
      headers: { ...auth, "last-event-id": "0" },
    });
    const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!text.includes("event: error")) text += (await reader.read()).value ?? "";
    await reader.cancel();
    expect(text).toContain("something went wrong");
  } finally {
    await failing.stop();
  }
});

test("parses GitHub remotes", () => {
  expect(parseGitHubRepo("git@github.com:Acme/Widgets.git")).toBe("acme/widgets");
  expect(parseGitHubRepo("https://github.com/acme/widgets")).toBe("acme/widgets");
  expect(parseGitHubRepo("https://gitlab.com/acme/widgets.git")).toBeNull();
});

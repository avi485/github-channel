#!/usr/bin/env bun
// Stands in for `claude -p --input-format stream-json --output-format stream-json` in tests.
// Reads one user message per line and answers each with "Answer <n> in <session id>",
// where n counts turns across resumes (kept in FAKE_CLAUDE_STATE/<session id>).
//
// FAKE_CLAUDE_MODE: "ok" (default) | "fail" (exit at once with an error)
// FAKE_CLAUDE_LOG: file that gets one JSON line per question: { args, cwd, resumeId, prompt }.
// --resume ids starting with "missing" fail like an unknown session.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const resumeId = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;
const emit = (e: unknown) => console.log(JSON.stringify(e));

if (process.env.FAKE_CLAUDE_MODE === "fail") {
  console.error("Error: something went wrong");
  process.exit(2);
}
if (resumeId?.startsWith("missing")) {
  console.error(`No conversation found with session ID: ${resumeId}`);
  process.exit(1);
}

const sessionId = resumeId ?? crypto.randomUUID();
const stateFile = join(process.env.FAKE_CLAUDE_STATE ?? "/tmp", sessionId);
let turns = existsSync(stateFile) ? Number(readFileSync(stateFile, "utf8")) : 0;
const log = (prompt: string) =>
  process.env.FAKE_CLAUDE_LOG &&
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd: process.cwd(), resumeId, prompt }) + "\n");

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    log(JSON.parse(line).message.content);
    turns++;
    writeFileSync(stateFile, String(turns));
    emit({ type: "system", subtype: "init", session_id: sessionId });
    emit({ type: "stream_event", event: { type: "message_start" }, session_id: sessionId });
    emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git show abc:src/a.ts" } }] } });
    emit({ type: "stream_event", event: { type: "message_start" } });
    const answer = `Answer ${turns} in ${sessionId}`;
    for (const part of answer.split(" ")) {
      emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: part + " " } } });
      await Bun.sleep(60);
    }
    emit({ type: "result", subtype: "success", is_error: false, result: answer, session_id: sessionId });
  }
}

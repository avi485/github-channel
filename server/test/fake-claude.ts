#!/usr/bin/env bun
// Stands in for `claude -p --output-format stream-json` in tests.
// FAKE_CLAUDE_MODE: "ok" (default) | "fail" | "error-result"
// FAKE_CLAUDE_LOG: file to write { args, cwd, prompt } to.
const prompt = await new Response(Bun.stdin.stream()).text();
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
if (process.env.FAKE_CLAUDE_LOG) {
  await Bun.write(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), prompt }));
}
const emit = (e: unknown) => console.log(JSON.stringify(e));

if (mode === "fail") {
  console.error("Error: something went wrong");
  process.exit(2);
}
emit({ type: "system", subtype: "init" });
emit({ type: "stream_event", event: { type: "message_start" } });
emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git show abc:src/a.ts" } }] } });
emit({ type: "stream_event", event: { type: "message_start" } });
for (const chunk of ["The answer ", "is ", "42."]) {
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: chunk } } });
  await Bun.sleep(200);
}
if (mode === "error-result") {
  emit({ type: "result", subtype: "error_max_turns", is_error: true, result: "" });
  process.exit(1);
}
emit({ type: "result", subtype: "success", is_error: false, result: "The answer is 42." });

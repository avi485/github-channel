import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TOKEN = "test-token-123";
export const auth = { authorization: `Bearer ${TOKEN}` };
const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");

export type Fixture = { dir: string; configDir: string; root: string; clone: string; logFile: string; stateDir: string };

/**
 * A temp config dir with the token and one repo (acme/widgets) mapped in repos.json,
 * plus a projects root holding one clone (acme/scanned) found by scanning.
 */
export async function createFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "github-channel-test-"));
  const f: Fixture = {
    dir,
    configDir: join(dir, "config"),
    root: join(dir, "projects"),
    clone: join(dir, "widgets"),
    logFile: join(dir, "claude-calls.jsonl"),
    stateDir: join(dir, "fake-state"),
  };
  await mkdir(f.configDir, { recursive: true });
  await mkdir(f.clone, { recursive: true });
  await mkdir(f.stateDir, { recursive: true });
  await mkdir(join(f.root, "scanned", ".git"), { recursive: true });
  await Bun.write(join(f.root, "scanned", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:Acme/Scanned.git\n');
  await Bun.write(join(f.configDir, "token"), TOKEN);
  await Bun.write(join(f.configDir, "repos.json"), JSON.stringify({ "Acme/Widgets": f.clone }));
  await chmod(FAKE_CLAUDE, 0o755);
  return f;
}

export type TestServer = { base: string; port: number; stop: () => Promise<void> };

/** Starts the real service against a fixture, with the fake `claude`. */
export async function startServer(f: Fixture, port: number, env: Record<string, string> = {}): Promise<TestServer> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/server.ts")], {
    env: {
      ...(process.env as Record<string, string>),
      GITHUB_CHANNEL_CONFIG_DIR: f.configDir,
      GITHUB_CHANNEL_ROOTS: f.root,
      GITHUB_CHANNEL_PORT: String(port),
      GITHUB_CHANNEL_CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_CLAUDE_LOG: f.logFile,
      FAKE_CLAUDE_STATE: f.stateDir,
      ...env,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${base}/info`);
      break;
    } catch {
      await Bun.sleep(50);
    }
  }
  return {
    base,
    port,
    stop: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}

/** Every question the fake claude received, oldest first. */
export async function claudeCalls(f: Fixture): Promise<{ args: string[]; cwd: string; resumeId?: string; prompt: string }[]> {
  const file = Bun.file(f.logFile);
  if (!(await file.exists())) return [];
  return (await file.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function post(base: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Asks a question and waits for its reply or error event; returns { type, text }. */
export async function askAndWait(base: string, body: { repo: string; pr: number; question: string } & Record<string, unknown>) {
  const chatId = `${body.repo}#${body.pr}`;
  const sse = await fetch(`${base}/events?chat_id=${encodeURIComponent(chatId)}`, { headers: auth });
  const res = await post(base, "/ask", body);
  if (res.status !== 202) throw new Error(`ask failed: ${res.status} ${await res.text()}`);
  const { message_id } = (await res.json()) as { message_id: string };
  const reader = sse.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  const all: { type: string; text: string; message_id: string }[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended");
    text += value;
    let sep;
    while ((sep = text.indexOf("\n\n")) !== -1) {
      const block = text.slice(0, sep);
      text = text.slice(sep + 2);
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      if (event.message_id !== message_id) continue;
      all.push(event);
      if (event.type === "reply" || event.type === "error") {
        await reader.cancel();
        return { type: event.type as string, text: event.text as string, events: all };
      }
    }
  }
}

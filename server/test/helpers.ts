import { chmod, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TOKEN = "test-token-123";
export const auth = { authorization: `Bearer ${TOKEN}` };
const FAKE_CLAUDE = join(import.meta.dir, "fake-claude.ts");

export type TestServer = {
  base: string;
  port: number;
  clone: string;
  logFile: string;
  stop: () => void;
};

/**
 * Starts the real service with a fake `claude`, a temp config dir, and one repo
 * (acme/widgets) mapped in repos.json plus one (acme/scanned) found by scanning.
 */
export async function startServer(port: number, env: Record<string, string> = {}): Promise<TestServer> {
  const dir = await mkdtemp(join(tmpdir(), "github-channel-test-"));
  const configDir = join(dir, "config");
  const root = join(dir, "projects");
  const clone = join(dir, "widgets");
  await mkdir(configDir, { recursive: true });
  await mkdir(clone, { recursive: true });
  await mkdir(join(root, "scanned", ".git"), { recursive: true });
  await Bun.write(join(root, "scanned", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:Acme/Scanned.git\n');
  await Bun.write(join(configDir, "token"), TOKEN);
  await Bun.write(join(configDir, "repos.json"), JSON.stringify({ "Acme/Widgets": clone }));
  await chmod(FAKE_CLAUDE, 0o755);
  const logFile = join(dir, "claude-call.json");

  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/server.ts")], {
    env: {
      ...(process.env as Record<string, string>),
      GITHUB_CHANNEL_CONFIG_DIR: configDir,
      GITHUB_CHANNEL_ROOTS: root,
      GITHUB_CHANNEL_PORT: String(port),
      GITHUB_CHANNEL_CLAUDE_BIN: FAKE_CLAUDE,
      FAKE_CLAUDE_LOG: logFile,
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
  return { base, port, clone, logFile, stop: () => proc.kill() };
}

/** Reads SSE text from a response until `done(text)` is true. */
export async function readUntil(res: Response, done: (text: string) => boolean): Promise<string> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (!done(text)) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    text += value;
  }
  await reader.cancel();
  return text;
}

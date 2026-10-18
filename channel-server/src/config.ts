import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const PORT_RANGE = { first: 8790, last: 8799 };

const CONFIG_DIR = process.env.GITHUB_CHANNEL_CONFIG_DIR ?? join(homedir(), ".config", "github-channel");
const TOKEN_FILE = join(CONFIG_DIR, "token");

/**
 * Shared pairing token. Every session's server reads the same file, so the
 * extension only has to be paired once.
 */
export async function loadOrCreateToken(): Promise<string> {
  const file = Bun.file(TOKEN_FILE);
  if (await file.exists()) {
    const token = (await file.text()).trim();
    if (token) return token;
  }
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Buffer.from(bytes).toString("base64url");
  await Bun.write(TOKEN_FILE, token + "\n");
  await chmod(TOKEN_FILE, 0o600);
  return token;
}

/** Parses "owner/repo" out of a GitHub remote URL (https or ssh form). */
export function parseGitHubRepo(remoteUrl: string): string | null {
  const match = remoteUrl.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** The repo this session reviews: GITHUB_CHANNEL_REPO, else the cwd's origin remote. */
export async function detectRepo(cwd: string): Promise<string | null> {
  const override = process.env.GITHUB_CHANNEL_REPO;
  if (override) return override.toLowerCase();
  const proc = Bun.spawn(["git", "remote", "get-url", "origin"], { cwd, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return null;
  return parseGitHubRepo(out);
}

/** Ports to try, in order. GITHUB_CHANNEL_PORT pins a single port. */
export function candidatePorts(): number[] {
  const pinned = process.env.GITHUB_CHANNEL_PORT;
  if (pinned) return [Number(pinned)];
  const ports: number[] = [];
  for (let p = PORT_RANGE.first; p <= PORT_RANGE.last; p++) ports.push(p);
  return ports;
}

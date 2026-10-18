import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = process.env.GITHUB_CHANNEL_CONFIG_DIR ?? join(homedir(), ".config", "github-channel");
const TOKEN_FILE = join(CONFIG_DIR, "token");

export const PORT = Number(process.env.GITHUB_CHANNEL_PORT ?? 8790);
export const CLAUDE_BIN = process.env.GITHUB_CHANNEL_CLAUDE_BIN ?? "claude";
export const CLAUDE_MODEL = process.env.GITHUB_CHANNEL_MODEL;
export const TIMEOUT_MS = Number(process.env.GITHUB_CHANNEL_TIMEOUT_MS ?? 10 * 60_000);
/** Folders scanned (two levels deep) for clones, colon-separated. */
export const SCAN_ROOTS = (process.env.GITHUB_CHANNEL_ROOTS ?? join(homedir(), "projects")).split(":").filter(Boolean);

/**
 * Shared pairing token, created on first run. The extension sends it with every
 * request so other extensions and local programs can't drive Claude.
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

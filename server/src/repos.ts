import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR, parseGitHubRepo } from "./config.ts";

const REPOS_FILE = join(CONFIG_DIR, "repos.json");
const RESCAN_AFTER_MS = 30_000;

/** origin remote of a clone, read from .git/config without running git. */
async function originOf(dir: string): Promise<string | null> {
  const file = Bun.file(join(dir, ".git", "config"));
  if (!(await file.exists())) return null; // Not a clone (worktrees have a .git file, which we skip).
  const text = await file.text();
  const section = text.split(/^\[/m).find((s) => /^remote\s+"origin"\]/.test(s));
  const url = section?.match(/^\s*url\s*=\s*(.+)$/m)?.[1];
  return url ? parseGitHubRepo(url) : null;
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * Maps "owner/repo" to a local clone. Entries in ~/.config/github-channel/repos.json
 * win; otherwise clones are found by scanning the roots two levels deep.
 */
export class RepoIndex {
  private repos = new Map<string, string>();
  private scannedAt = 0;

  constructor(private readonly roots: string[]) {}

  async scan(): Promise<void> {
    const found = new Map<string, string>();
    for (const root of this.roots) {
      for (const dir of await subdirs(root)) {
        const repo = await originOf(dir);
        if (repo) {
          if (!found.has(repo)) found.set(repo, dir);
          continue;
        }
        for (const inner of await subdirs(dir)) {
          const innerRepo = await originOf(inner);
          if (innerRepo && !found.has(innerRepo)) found.set(innerRepo, inner);
        }
      }
    }
    const file = Bun.file(REPOS_FILE);
    if (await file.exists()) {
      const configured = (await file.json()) as Record<string, string>;
      for (const [repo, dir] of Object.entries(configured)) found.set(repo.toLowerCase(), dir);
    }
    this.repos = found;
    this.scannedAt = Date.now();
  }

  /** The clone for a repo, rescanning (at most every 30s) when it isn't known yet. */
  async find(repo: string): Promise<string | null> {
    const key = repo.toLowerCase();
    if (!this.repos.has(key) && Date.now() - this.scannedAt > RESCAN_AFTER_MS) await this.scan();
    return this.repos.get(key) ?? null;
  }

  list(): string[] {
    return [...this.repos.keys()].sort();
  }
}

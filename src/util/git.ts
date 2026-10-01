import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { RunStats } from '../core/types.js';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function isGitRepo(root: string): boolean {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  } catch {
    return false;
  }
}

export function lfsReady(root: string): boolean {
  try {
    git(root, ['lfs', 'version']);
    return true;
  } catch {
    return false;
  }
}

export function summary(stats: RunStats): string {
  const parts = [];
  if (stats.added) parts.push(`${stats.added} новых`);
  if (stats.changed) parts.push(`${stats.changed} изменено`);
  if (stats.failed) parts.push(`${stats.failed} ошибок`);
  if (stats.unsafe) parts.push(`${stats.unsafe} в карантине`);
  return parts.join(', ') || 'без изменений';
}

/** Commit library changes only (never sessions or local state). Returns the commit hash or undefined. */
export function commitLibrary(root: string, paths: string[], message: string): string | undefined {
  const existing = paths.filter((p) => fs.existsSync(path.resolve(root, p)));
  if (!existing.length) return undefined;
  git(root, ['add', '-A', '--', ...existing]);
  const staged = git(root, ['diff', '--cached', '--name-only', '--', ...existing]);
  if (!staged) return undefined;
  // Pathspec keeps anything else the user had staged out of the automatic commit.
  git(root, ['commit', '-m', message, '--', ...existing]);
  return git(root, ['rev-parse', '--short', 'HEAD']);
}

export function push(root: string): void {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  execFileSync('git', ['push', '-u', 'origin', branch], { cwd: root, stdio: 'inherit' });
}

/** Versions of a library file from git history: newest first. */
export function fileHistory(root: string, rel: string): { commit: string; date: string; subject: string }[] {
  try {
    const out = git(root, ['log', '--format=%h%x09%aI%x09%s', '--', rel]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [commit, date, subject] = line.split('\t');
        return { commit, date, subject };
      });
  } catch {
    return [];
  }
}

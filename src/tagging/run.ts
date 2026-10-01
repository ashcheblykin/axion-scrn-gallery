import type { Workspace } from '../config/load.js';
import { Library } from '../library/store.js';
import type { Logger } from '../util/log.js';
import { hasApiCredentials, tagWithApi } from './api.js';
import { findClaudeCli, tagWithClaudeCode } from './claude-code.js';
import { taggingQueue, type TagResult } from './tags.js';

export type TagProvider = 'claude-code' | 'api' | 'off';

export interface RunTaggingOptions {
  provider?: TagProvider;
  ids?: string[];
  all?: boolean;
  limit?: number;
  log: Logger;
}

export interface RunTaggingResult extends TagResult {
  provider: TagProvider;
  /** Why nothing ran (no Claude Code CLI, no key, provider off) and what to do instead. */
  hint?: string;
}

const INTERACTIVE_HINT = 'открой Claude Code в репозитории и выполни /tag-screens';

/**
 * Tag new/changed screens with the configured provider. Writes go straight to library/index.json,
 * so callers must re-open their Library afterwards.
 */
export async function runTagging(ws: Workspace, o: RunTaggingOptions): Promise<RunTaggingResult> {
  const provider = o.provider ?? ws.config.tagging.provider;
  const empty = { tagged: 0, flagged: [], skipped: 0, errors: [] };
  if (provider === 'off') return { ...empty, provider, hint: 'tagging.provider: off' };
  if (!taggingQueue(Library.open(ws.paths.library), o).length) return { ...empty, provider };

  if (provider === 'api') {
    if (!hasApiCredentials()) return { ...empty, provider, hint: `нет ANTHROPIC_API_KEY — ${INTERACTIVE_HINT}` };
    const library = Library.open(ws.paths.library);
    const r = await tagWithApi(ws, library, o);
    library.save();
    return { ...r, provider };
  }

  if (!findClaudeCli(ws.config.tagging.claudePath)) {
    return { ...empty, provider, hint: `не найден Claude Code CLI (claude) — ${INTERACTIVE_HINT}` };
  }
  return { ...(await tagWithClaudeCode(ws, o)), provider };
}

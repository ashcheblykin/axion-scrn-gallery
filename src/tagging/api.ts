import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { Workspace } from '../config/load.js';
import { isLfsPointer, type Library } from '../library/store.js';
import { preview } from '../process/images.js';
import type { Logger } from '../util/log.js';
import { errorMessage, mapPool } from '../util/pool.js';
import { applyTags, screenContext, tagSchema, taggingGuide, taggingQueue, type TagResult } from './tags.js';

/** Optional provider (tagging.provider: api) for teams that prefer an API key over a Claude Code subscription. */

export function hasApiCredentials(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  return fs.existsSync(path.join(os.homedir(), '.config', 'anthropic'));
}

export interface ApiTagOptions {
  ids?: string[];
  all?: boolean;
  limit?: number;
  log: Logger;
}

export async function tagWithApi(ws: Workspace, library: Library, opts: ApiTagOptions): Promise<TagResult> {
  const cfg = ws.config.tagging;
  const result: TagResult = { tagged: 0, flagged: [], skipped: 0, errors: [] };
  let queue = taggingQueue(library, opts);
  if (opts.limit) queue = queue.slice(0, opts.limit);
  if (!queue.length) return result;

  const client = new Anthropic();
  const schema = tagSchema(ws);
  const system = taggingGuide(ws);

  await mapPool(queue, cfg.concurrency, async (screen) => {
    const file = library.abs(screen.files.default.path);
    if (!fs.existsSync(file) || isLfsPointer(file)) {
      result.skipped++;
      return;
    }
    try {
      const image = await preview(fs.readFileSync(file), cfg.maxImageEdge, 'png');
      const response = await client.beta.messages.parse({
        model: cfg.model,
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        output_config: { effort: cfg.effort, format: betaZodOutputFormat(schema) },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.toString('base64') } },
              { type: 'text', text: screenContext(ws, screen) },
            ],
          },
        ],
      });

      if (response.stop_reason === 'refusal') throw new Error('модель отказалась размечать экран');
      const tags = response.parsed_output;
      if (!tags) throw new Error(`пустой ответ (stop_reason: ${response.stop_reason})`);

      applyTags(library, screen, tags, { source: 'claude-api', model: response.model });
      result.tagged++;
      if (tags.privacy.flagged) {
        result.flagged.push(screen.id);
        opts.log.warn(`${screen.id}: privacy-аудит — ${tags.privacy.findings.join('; ')}`);
      } else {
        opts.log.ok(`${screen.id}: ${tags.patterns.join(', ')}`);
      }
    } catch (err) {
      let message = errorMessage(err);
      if (err instanceof Anthropic.AuthenticationError) message = 'нет доступа к Claude API — проверь ANTHROPIC_API_KEY';
      else if (err instanceof Anthropic.RateLimitError) message = 'rate limit Claude API — повтори позже или снизь tagging.concurrency';
      result.errors.push(`${screen.id}: ${message}`);
      opts.log.error(`${screen.id}: ${message}`);
    }
  });
  return result;
}

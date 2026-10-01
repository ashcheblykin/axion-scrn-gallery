import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ACTION_ARGS, ActionSchema, ConfigSchema, ProductSchema } from '../config/schema.js';

function withoutMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _meta, ...rest } = schema;
  return rest;
}

/** `- click: "…"` — one single-key object per action, so editors can autocomplete action names. */
function actionJsonSchema(): Record<string, unknown> {
  return {
    oneOf: Object.entries(ACTION_ARGS).map(([kind, arg]) => ({
      type: 'object',
      properties: { [kind]: withoutMeta(z.toJSONSchema(arg, { io: 'input' })) },
      required: [kind],
      additionalProperties: false,
    })),
  };
}

/** JSON Schemas for editor autocompletion in YAML (yaml-language-server `$schema` comments). */
export function writeJsonSchemas(root: string): string[] {
  const dir = path.join(root, 'schemas');
  fs.mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  const action = actionJsonSchema();
  for (const [name, schema] of [
    ['config', ConfigSchema],
    ['product', ProductSchema],
  ] as const) {
    const json = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
      override: (ctx) => {
        if (ctx.zodSchema === ActionSchema) {
          for (const k of Object.keys(ctx.jsonSchema)) delete (ctx.jsonSchema as Record<string, unknown>)[k];
          Object.assign(ctx.jsonSchema, action);
        }
      },
    });
    const file = path.join(dir, `${name}.schema.json`);
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    out.push(file);
  }
  return out;
}

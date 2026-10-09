import { z } from 'zod';

/**
 * Schemas for `scrn.config.yaml` (engine settings) and `catalog/**` (what to capture).
 * The catalog follows Mobbin's model: product → platform → flow → ordered steps (screens),
 * plus sections (element-level crops) inside a screen.
 */

export const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const slug = (what: string) =>
  z.string().regex(SLUG, `${what}: только латиница в нижнем регистре, цифры и дефис (kebab-case)`);

// ---------------------------------------------------------------------------
// Actions DSL
// ---------------------------------------------------------------------------

const Target = z.union([
  z.string(),
  z.object({
    selector: z.string(),
    nth: z.number().int().optional(),
    force: z.boolean().optional(),
    timeout: z.number().int().optional(),
  }),
]);

export const ACTION_ARGS = {
  goto: z.string(),
  click: Target,
  dblclick: Target,
  hover: Target,
  fill: z.object({ selector: z.string(), value: z.string() }),
  type: z.object({ selector: z.string(), text: z.string(), delay: z.number().optional() }),
  press: z.union([z.string(), z.object({ selector: z.string().optional(), key: z.string() })]),
  select: z.object({ selector: z.string(), value: z.union([z.string(), z.array(z.string())]) }),
  check: z.string(),
  uncheck: z.string(),
  scroll: z.object({
    selector: z.string().optional(),
    to: z.union([z.enum(['top', 'bottom']), z.number()]).optional(),
    by: z.number().optional(),
  }),
  scrollIntoView: z.string(),
  wait: z.number().int().nonnegative(),
  waitFor: z.union([
    z.string(),
    z.object({
      selector: z.string(),
      state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(),
      timeout: z.number().int().optional(),
    }),
  ]),
  waitForUrl: z.string(),
  waitForNetworkIdle: z.union([z.literal(true), z.number().int()]),
  evaluate: z.string(),
  setViewport: z.object({ width: z.number().int().optional(), height: z.number().int().optional() }),
  localStorage: z.record(z.string(), z.string()),
  reload: z.literal(true),
  emulate: z.object({
    colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
    reducedMotion: z.enum(['reduce', 'no-preference']).optional(),
  }),
  mouse: z.object({ x: z.number(), y: z.number(), click: z.boolean().optional() }),
} as const;

export type ActionKind = keyof typeof ACTION_ARGS;
export type Action = {
  [K in ActionKind]: { kind: K; arg: z.infer<(typeof ACTION_ARGS)[K]> };
}[ActionKind];

export const ACTION_KINDS = Object.keys(ACTION_ARGS) as ActionKind[];

/** `- click: "text=Insights"` → `{ kind: 'click', arg: 'text=Insights' }` */
export const ActionSchema = z
  .record(z.string(), z.unknown())
  .transform((obj, ctx): Action => {
    const keys = Object.keys(obj);
    if (keys.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: `действие должно содержать ровно один ключ, получено: ${keys.join(', ') || '—'}`,
      });
      return z.NEVER;
    }
    const kind = keys[0] as ActionKind;
    const argSchema = ACTION_ARGS[kind];
    if (!argSchema) {
      ctx.addIssue({
        code: 'custom',
        message: `неизвестное действие "${kind}". Доступны: ${ACTION_KINDS.join(', ')}`,
      });
      return z.NEVER;
    }
    const parsed = argSchema.safeParse(obj[kind]);
    if (!parsed.success) {
      ctx.addIssue({ code: 'custom', message: `${kind}: ${parsed.error.issues.map((i) => i.message).join('; ')}` });
      return z.NEVER;
    }
    return { kind, arg: parsed.data } as Action;
  });

// ---------------------------------------------------------------------------
// Catalog: sections, steps, flows, products
// ---------------------------------------------------------------------------

export const SectionSchema = z.object({
  id: slug('section.id'),
  name: z.string(),
  description: z.string().optional(),
  selector: z.string(),
  nth: z.number().int().optional(),
  /** Transparent margin around the element so its shadow is kept (CSS px). */
  padding: z.number().nonnegative().default(24),
  /** Force rounded corners (CSS px). By default the element's own border-radius is kept. */
  radius: z.number().nonnegative().optional(),
  /** Paint a background on the isolated element (for cards that rely on the parent's background). */
  fill: z.string().optional(),
  patterns: z.array(z.string()).default([]),
  elements: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

const StepOverrideSchema = z.object({
  url: z.string().optional(),
  actions: z.array(ActionSchema).optional(),
  sections: z.array(SectionSchema).optional(),
  viewport: z.object({ width: z.number().int().optional(), height: z.number().int().optional() }).optional(),
  enabled: z.boolean().optional(),
});

export const FigmaSourceSchema = z.object({
  /** File key from figma.com/design/<key>/… */
  file: z.string(),
  /** Node id: "2115:61550" or "2115-61550" (as in the node-id URL param). */
  node: z.string(),
  scale: z.number().min(0.01).max(4).optional(),
});

export const StepSchema = z.object({
  id: slug('step.id'),
  name: z.string(),
  description: z.string().optional(),
  /** Navigate before actions. Relative paths resolve against the environment baseUrl; {vars} are interpolated. */
  url: z.string().optional(),
  actions: z.array(ActionSchema).default([]),
  /** Actions after the capture (close a modal, go back) — keeps the flow state clean for the next step. */
  after: z.array(ActionSchema).default([]),
  platforms: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
  /** What is still unknown (route, selector…). Steps with `todo` are skipped until it is removed. */
  todo: z.string().optional(),
  /** Mobbin-like taxonomy (see catalog/taxonomy.yaml). */
  patterns: z.array(z.string()).default([]),
  elements: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  viewport: z.object({ width: z.number().int().optional(), height: z.number().int().optional() }).optional(),
  /** Force the full-page variant on/off for this step (default: only when content overflows). */
  full: z.boolean().optional(),
  delay: z.number().int().nonnegative().optional(),
  waitFor: z.array(z.string()).default([]),
  hide: z.array(z.string()).default([]),
  ignoreInDiff: z.array(z.string()).default([]),
  sections: z.array(SectionSchema).default([]),
  /** Take this screen from Figma instead of the live product (e.g. mobile, where Figma is ahead of code). */
  figma: FigmaSourceSchema.optional(),
  /** Per-platform overrides: `on: { mobile: { actions: [...] } }`. */
  on: z.record(z.string(), StepOverrideSchema).default({}),
});

export const FlowSchema = z.object({
  id: slug('flow.id'),
  name: z.string(),
  description: z.string().optional(),
  /** Key of the presentation brief screen this flow covers (quality-check, executive-summary, …). */
  brief: z.string().optional(),
  /** Mobbin-like flow action categories: Viewing, Filtering & Sorting, Reviewing, Chatting… */
  actions: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  platforms: z.array(z.string()).optional(),
  enabled: z.boolean().default(true),
  todo: z.string().optional(),
  priority: z.number().int().default(0),
  steps: z.array(StepSchema).min(1),
});

const ThemeSchema = z.object({
  id: slug('theme.id'),
  colorScheme: z.enum(['light', 'dark', 'no-preference']).optional(),
  localStorage: z.record(z.string(), z.string()).default({}),
  /** JS executed after navigation (e.g. toggling a class on <html>). */
  evaluate: z.string().optional(),
});

const LocaleSchema = z.object({
  id: slug('locale.id'),
  /** BCP-47 tag passed to the browser (Accept-Language, Intl). */
  locale: z.string().optional(),
  localStorage: z.record(z.string(), z.string()).default({}),
  evaluate: z.string().optional(),
});

export const ANON_KINDS = ['person', 'org', 'email', 'digits', 'chars', 'text', 'lorem'] as const;
export type AnonKind = (typeof ANON_KINDS)[number];

const AnonRuleSchema = z.object({
  selector: z.string(),
  kind: z.enum(ANON_KINDS),
  /** Fixed value for kind: text. */
  value: z.string().optional(),
});

const ImageRuleSchema = z.object({
  selector: z.string(),
  /** logo — neutral "A" mark, avatar — generated initials, blur — blur in place, hide — keep layout, hide pixels, or a path to an image file. */
  with: z.string(),
});

const NetworkRuleSchema = z.object({
  /** Playwright URL glob, e.g. "**\/api/**". */
  url: z.string(),
  /** Rewrite string values of JSON responses with the anonymization dictionary. */
  anonymize: z.boolean().optional(),
  /** Replace the response body with this JSON (e.g. the current-user endpoint). */
  json: z.unknown().optional(),
  /** Deep-merge these fields into the JSON response. */
  merge: z.record(z.string(), z.unknown()).optional(),
  block: z.boolean().optional(),
  /** JSON keys whose values must not be touched (ids, enums the app logic depends on). */
  keepKeys: z.array(z.string()).optional(),
});

export const ProductAnonymizeSchema = z.object({
  rules: z.array(AnonRuleSchema).default([]),
  images: z.array(ImageRuleSchema).default([]),
  blur: z.array(z.string()).default([]),
  hide: z.array(z.string()).default([]),
  network: z.array(NetworkRuleSchema).default([]),
  /** Extra literal terms for the guard, product-specific. */
  blocklist: z.array(z.string()).default([]),
});

export const ProductSchema = z.object({
  id: slug('product.id'),
  name: z.string(),
  description: z.string().optional(),
  environments: z.record(
    z.string(),
    z.object({
      baseUrl: z.string().url(),
      vars: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    }),
  ),
  vars: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  auth: z
    .object({
      /** Session file name: .auth/<profile>-<env>.json. Products on one host may share a profile. */
      profile: slug('auth.profile').optional(),
      required: z.boolean().default(true),
      startUrl: z.string().default('/'),
      loggedIn: z
        .object({
          urlNotMatches: z.string().optional(),
          urlMatches: z.string().optional(),
          selector: z.string().optional(),
        })
        .prefault({}),
      sessionStorage: z.boolean().default(true),
      httpCredentials: z.object({ username: z.string(), password: z.string() }).optional(),
      headers: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
  platforms: z.array(z.string()).default(['desktop', 'mobile']),
  themes: z.array(ThemeSchema).default([{ id: 'default', localStorage: {} }]),
  locales: z.array(LocaleSchema).default([{ id: 'en', localStorage: {} }]),
  capture: z
    .object({
      settleMs: z.number().int().nonnegative().optional(),
      waitFor: z.array(z.string()).default([]),
      /** Spinners/skeletons that must disappear before the shot. */
      waitForHidden: z.array(z.string()).default([]),
      hide: z.array(z.string()).default([]),
      /** Main scroll container (for full-page shots of apps that scroll inside <main>). Auto-detected if empty. */
      scrollContainer: z.string().optional(),
      /** What counts as "background" for the transparent (.clear) variant. */
      backdrop: z.array(z.string()).default(['html', 'body', '#root', '#app', '#__next']),
      /** App chrome (sidebar, top bar) hidden in the .cards variant. */
      chrome: z.array(z.string()).default([]),
      blockRequests: z.array(z.string()).default([]),
      ignoreInDiff: z.array(z.string()).default([]),
      css: z.string().optional(),
    })
    .prefault({}),
  anonymize: ProductAnonymizeSchema.prefault({}),
  discover: z
    .object({
      /** Navigation containers: their links (and collapsed groups, href-less items) are the sections. */
      navSelectors: z.array(z.string()).default(['nav', 'aside', '[role=navigation]', 'header', '[role=menubar]']),
      exclude: z.array(z.string()).default(['logout', 'signout', 'sign-out', 'auth', 'login']),
      /** Pages visited per product (0 — do not crawl the product). */
      maxPages: z.number().int().nonnegative().default(150),
      /** Tabs, panels and row details captured as states, per product. */
      maxStates: z.number().int().nonnegative().default(150),
      maxTabs: z.number().int().nonnegative().default(8),
      /** 1 — nav sections only; 2 — plus pages linked from them (details); 3 — and one level deeper. */
      depth: z.number().int().min(0).max(4).default(3),
      /** Platforms the discovered flows are captured on (mobile only if the web app is responsive). */
      platforms: z.array(z.string()).default(['desktop']),
    })
    .prefault({}),
  flows: z.array(FlowSchema).default([]),
});

// ---------------------------------------------------------------------------
// Anonymization dictionary (catalog/anonymize.yaml)
// ---------------------------------------------------------------------------

export const DictionarySchema = z.object({
  personas: z
    .object({
      latin: z.array(z.string()).min(1),
      arabic: z.array(z.string()).min(1),
      cyrillic: z.array(z.string()).min(1),
    }),
  organizations: z.array(z.string()).min(1),
  /** Real people (any script) that must be replaced by personas. */
  people: z.array(z.string()).default([]),
  terms: z.array(z.object({ match: z.string(), replace: z.string() })).default([]),
  patterns: z
    .array(
      z.object({
        name: z.string(),
        regex: z.string(),
        flags: z.string().optional(),
        kind: z.enum(ANON_KINDS),
        value: z.string().optional(),
      }),
    )
    .default([]),
  /** Must never be visible on a published screen. people + terms[].match are included automatically. */
  blocklist: z.array(z.string()).default([]),
  emailDomain: z.string().default('example.com'),
});

// ---------------------------------------------------------------------------
// Taxonomy (catalog/taxonomy.yaml) — controlled vocabulary shared by YAML, tagging and MCP search
// ---------------------------------------------------------------------------

export const TaxonomySchema = z.object({
  patterns: z.array(z.string()).min(1),
  elements: z.array(z.string()).min(1),
  flowActions: z.array(z.string()).min(1),
  briefs: z
    .array(z.object({ id: slug('brief.id'), name: z.string(), description: z.string().optional() }))
    .default([]),
});

// ---------------------------------------------------------------------------
// Engine config (scrn.config.yaml)
// ---------------------------------------------------------------------------

const PlatformSpecSchema = z.object({
  /** Playwright device descriptor name, e.g. "iPhone 15 Pro". */
  device: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** deviceScaleFactor: 2 = Retina. */
  scale: z.number().positive().optional(),
  isMobile: z.boolean().optional(),
  hasTouch: z.boolean().optional(),
  userAgent: z.string().optional(),
});
export type PlatformSpec = z.infer<typeof PlatformSpecSchema>;

export const ConfigSchema = z.object({
  library: z.string().default('library'),
  catalog: z.string().default('catalog'),
  environment: z.string().default('stage'),
  timezone: z.string().default('Asia/Riyadh'),
  concurrency: z.number().int().min(1).max(16).default(2),
  browser: z
    .object({
      executablePath: z.string().optional(),
      args: z.array(z.string()).default([]),
    })
    .prefault({}),
  platforms: z.record(z.string(), PlatformSpecSchema).default({
    desktop: { width: 1440, height: 900, scale: 2 },
    mobile: { device: 'iPhone 15 Pro', scale: 3 },
  }),
  capture: z
    .object({
      settleMs: z.number().int().nonnegative().default(800),
      navigationTimeoutMs: z.number().int().positive().default(45_000),
      networkIdleTimeoutMs: z.number().int().positive().default(8_000),
      actionTimeoutMs: z.number().int().positive().default(15_000),
      maxFullHeight: z.number().int().positive().default(7_000),
      retries: z.number().int().min(0).max(5).default(1),
      hideScrollbars: z.boolean().default(true),
      /** ISO timestamp: freeze Date.now() for reproducible "today" labels. */
      freezeTime: z.string().optional(),
    })
    .prefault({}),
  variants: z
    .object({
      full: z.boolean().default(true),
      clear: z.boolean().default(true),
      cards: z.boolean().default(true),
      /** Editable vector SVG next to every PNG variant and section (text stays text — for Figma and slides). */
      svg: z.boolean().default(true),
      thumbWidth: z.number().int().positive().default(720),
      thumbQuality: z.number().int().min(1).max(100).default(78),
    })
    .prefault({}),
  diff: z
    .object({
      /** Share of differing pixels above which a screen counts as changed (new version). */
      threshold: z.number().min(0).max(1).default(0.004),
      /** pixelmatch per-pixel color tolerance. */
      pixelThreshold: z.number().min(0).max(1).default(0.1),
    })
    .prefault({}),
  anonymize: z
    .object({
      dictionary: z.string().default('catalog/anonymize.yaml'),
      /** strict — unsafe screens go to .scrn/quarantine and are not published; warn — published with a flag; off. */
      guard: z.enum(['strict', 'warn', 'off']).default('strict'),
      observeMutations: z.boolean().default(true),
    })
    .prefault({}),
  tagging: z
    .object({
      /**
       * claude-code — Claude Code on the user's subscription (headless `claude -p` in refresh, /tag-screens interactively);
       * api — Anthropic API key; off — no auto-tagging.
       */
      provider: z.enum(['claude-code', 'api', 'off']).default('claude-code'),
      /** Screens per tagging_queue batch (each comes with a preview image). */
      batchSize: z.number().int().min(1).max(8).default(4),
      /** Preview size handed to the model, long edge in px. */
      maxImageEdge: z.number().int().positive().default(1568),
      /** Path to the `claude` CLI if it is not on PATH (also SCRN_CLAUDE_PATH). */
      claudePath: z.string().optional(),
      /** Model for headless Claude Code (alias like "sonnet" or a full id); default — the user's Claude Code default. */
      claudeModel: z.string().optional(),
      /** provider: api only */
      model: z.string().default('claude-opus-5-5'),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('low'),
      concurrency: z.number().int().min(1).max(16).default(3),
    })
    .prefault({}),
  git: z
    .object({
      commit: z.boolean().default(false),
      push: z.boolean().default(false),
      message: z.string().default('scrn: refresh {date} — {summary}'),
    })
    .prefault({}),
  schedule: z.object({ cron: z.string().default('0 7 * * 1') }).prefault({}),
  links: z
    .object({
      /** https://github.com/<owner>/<repo> — used for links in MCP results and the gallery. */
      repoUrl: z.string().optional(),
      branch: z.string().default('main'),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Flow = z.infer<typeof FlowSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Section = z.infer<typeof SectionSchema>;
export type Dictionary = z.infer<typeof DictionarySchema>;
export type Taxonomy = z.infer<typeof TaxonomySchema>;
export type ProductAnonymize = z.infer<typeof ProductAnonymizeSchema>;
export type NetworkRule = ProductAnonymize['network'][number];
export type Theme = Product['themes'][number];
export type LocaleSpec = Product['locales'][number];

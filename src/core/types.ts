/** Records persisted in library/index.json — the single source of truth for the gallery, MCP and git history. */

export type ScreenStatus = 'ok' | 'unsafe' | 'review' | 'failed' | 'auth_required' | 'orphaned';
export type ScreenSource = 'web' | 'figma' | 'discover';

export interface ImageFile {
  /** Relative to the library root, POSIX separators. */
  path: string;
  width: number;
  height: number;
  bytes: number;
}

export interface PrivacyAudit {
  flagged: boolean;
  findings: string[];
  at: string;
}

export interface SectionRecord {
  /** `<screenId>--<sectionId>` */
  id: string;
  screenId: string;
  section: string;
  name: string;
  description?: string;
  patterns: string[];
  elements: string[];
  tags: string[];
  file: ImageFile;
  thumb?: ImageFile;
  /** Editable vector version (width/height in CSS px). */
  svg?: ImageFile;
}

export interface ScreenRecord {
  /** `<product>.<platform>.<flow>.<step>[.<theme>][.<locale>]` */
  id: string;
  product: string;
  platform: string;
  theme: string;
  locale: string;
  flow: string;
  flowName: string;
  step: string;
  /** 1-based position of the step inside its flow. */
  position: number;
  title: string;
  description?: string;
  brief?: string;
  source: ScreenSource;
  /** Path + query inside the product (no origin). */
  route?: string;
  patterns: string[];
  elements: string[];
  tags: string[];
  keywords: string[];
  /** Visible text excerpt after anonymization — feeds full-text search. */
  text?: string;
  files: {
    default: ImageFile;
    thumb: ImageFile;
    full?: ImageFile;
    clear?: ImageFile;
    cards?: ImageFile;
    /** Editable vector versions (text as text, cards as shapes); width/height in CSS px. */
    svg?: ImageFile;
    fullSvg?: ImageFile;
    clearSvg?: ImageFile;
    cardsSvg?: ImageFile;
  };
  sections: SectionRecord[];
  viewport: { width: number; height: number; scale: number };
  /** Content continues below the first viewport (see files.full). */
  overflow: boolean;
  fullHeight?: number;
  version: number;
  /** sha256 of the default image pixels — changes only with a new version. */
  hash: string;
  capturedAt: string;
  changedAt: string;
  status: ScreenStatus;
  error?: string;
  anonymization: {
    replacements: number;
    images: number;
    violations: string[];
    /** Fake values the anonymizer put on this screen (lower-cased) — the privacy audit must not flag them. */
    substitutes?: string[];
    audit?: PrivacyAudit;
  };
  /** What the pixels depend on besides the app (engine version, anonymization rules, dictionary, logo). */
  fingerprint?: string;
  tagging?: { source: 'claude-code' | 'claude-api' | 'heuristics'; model?: string; at: string; hash: string };
  quality?: { cutOff?: boolean; emptyState?: boolean; loading?: boolean; broken?: boolean; notes?: string };
  suggestedUse?: string[];
}

export interface FlowRecord {
  /** `<product>.<platform>.<flow>` */
  id: string;
  product: string;
  platform: string;
  flow: string;
  name: string;
  description?: string;
  brief?: string;
  actions: string[];
  tags: string[];
  /** Screen ids of the default theme/locale, in step order. */
  steps: string[];
}

export interface RunStats {
  captured: number;
  added: number;
  changed: number;
  unchanged: number;
  failed: number;
  unsafe: number;
  skipped: number;
}

export interface RunRecord {
  id: string;
  startedAt: string;
  finishedAt: string;
  environment: string;
  targets: string[];
  stats: RunStats;
  notes: string[];
}

export interface ProductRecord {
  id: string;
  name: string;
  description?: string;
  platforms: string[];
}

export interface LibraryIndex {
  schemaVersion: 1;
  updatedAt: string;
  products: ProductRecord[];
  flows: FlowRecord[];
  screens: ScreenRecord[];
  runs: RunRecord[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the capture engine hands to the library for one screen. */
export interface CapturedScreen {
  id: string;
  product: string;
  platform: string;
  theme: string;
  locale: string;
  flow: string;
  flowName: string;
  step: string;
  position: number;
  title: string;
  description?: string;
  brief?: string;
  source: ScreenSource;
  route?: string;
  patterns: string[];
  elements: string[];
  tags: string[];
  text?: string;
  viewport: { width: number; height: number; scale: number };
  overflow: boolean;
  fullHeight?: number;
  images: {
    default: Buffer;
    full?: Buffer;
    clear?: Buffer;
    cards?: Buffer;
    /** Vector twins of the raster variants. */
    svg?: { default?: string; full?: string; clear?: string; cards?: string };
    sections: {
      id: string;
      name: string;
      description?: string;
      patterns: string[];
      elements: string[];
      tags: string[];
      buffer: Buffer;
      svg?: string;
    }[];
  };
  /** Regions (device px) excluded from the change detection: clocks, live maps… */
  ignoreRects: Rect[];
  fingerprint?: string;
  anonymization: { replacements: number; images: number; violations: string[]; substitutes?: string[] };
}

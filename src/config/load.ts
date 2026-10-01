import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { z } from 'zod';
import {
  ConfigSchema,
  DictionarySchema,
  ProductSchema,
  TaxonomySchema,
  type Config,
  type Dictionary,
  type Product,
  type Taxonomy,
} from './schema.js';

export const CONFIG_FILE = 'scrn.config.yaml';

export interface Workspace {
  root: string;
  config: Config;
  products: Product[];
  dictionary: Dictionary;
  taxonomy: Taxonomy;
  /** Non-fatal catalog problems (unknown taxonomy terms, unknown platforms…). */
  warnings: string[];
  paths: {
    library: string;
    catalog: string;
    auth: string;
    state: string;
    exports: string;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Walk up from `start` to the directory that holds scrn.config.yaml. */
export function findRoot(start = process.cwd()): string {
  if (process.env.SCRN_ROOT) return path.resolve(process.env.SCRN_ROOT);
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new ConfigError(`Не найден ${CONFIG_FILE} (искал от ${start} вверх). Запусти команду из репозитория axion-scrn-gallery.`);
    }
    dir = parent;
  }
}

/** `${VAR}` and `${VAR:-fallback}` in any string value of the YAML tree. */
export function interpolateEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
      const v = env[name];
      return v !== undefined && v !== '' ? v : (fallback ?? '');
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolateEnv(v, env)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env)])) as T;
  }
  return value;
}

function readYaml(file: string): unknown {
  const text = fs.readFileSync(file, 'utf8');
  const doc = YAML.parseDocument(text, { prettyErrors: true });
  if (doc.errors.length) {
    throw new ConfigError(`${file}: ошибка YAML\n${doc.errors.map((e) => e.message).join('\n')}`);
  }
  return doc.toJS() ?? {};
}

function parseWith<S extends z.ZodType>(schema: S, data: unknown, file: string): z.infer<S> {
  const res = schema.safeParse(data);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  • ${i.path.join('.') || '(корень)'}: ${i.message}`);
    throw new ConfigError(`${file}: конфигурация не прошла проверку\n${lines.join('\n')}`);
  }
  return res.data;
}

function loadEnvFile(root: string) {
  const envPath = path.join(root, '.env');
  if (fs.existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // malformed .env is not fatal — explicit env vars still work
    }
  }
}

export function loadWorkspace(opts: { root?: string } = {}): Workspace {
  const root = opts.root ? path.resolve(opts.root) : findRoot();
  loadEnvFile(root);

  const configFile = path.join(root, CONFIG_FILE);
  const config = parseWith(ConfigSchema, interpolateEnv(readYaml(configFile)), configFile);
  if (process.env.SCRN_ENV) config.environment = process.env.SCRN_ENV;

  const catalogDir = path.resolve(root, config.catalog);
  const productsDir = path.join(catalogDir, 'products');
  if (!fs.existsSync(productsDir)) throw new ConfigError(`Нет каталога продуктов: ${productsDir}`);

  const products = fs
    .readdirSync(productsDir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()
    .map((f) => {
      const file = path.join(productsDir, f);
      return parseWith(ProductSchema, interpolateEnv(readYaml(file)), file);
    });

  const dictFile = path.resolve(root, config.anonymize.dictionary);
  const dictionary = parseWith(DictionarySchema, readYaml(dictFile), dictFile);

  const taxonomyFile = path.join(catalogDir, 'taxonomy.yaml');
  const taxonomy = parseWith(TaxonomySchema, readYaml(taxonomyFile), taxonomyFile);

  const warnings = validateCatalog(products, config, taxonomy);

  return {
    root,
    config,
    products,
    dictionary,
    taxonomy,
    warnings,
    paths: {
      library: path.resolve(root, config.library),
      catalog: catalogDir,
      auth: path.join(root, '.auth'),
      state: path.join(root, '.scrn'),
      exports: path.join(root, 'exports'),
    },
  };
}

/** Cross-file checks: duplicate ids are fatal, unknown vocabulary is a warning. */
export function validateCatalog(products: Product[], config: Config, taxonomy: Taxonomy): string[] {
  const warnings: string[] = [];
  const seenProducts = new Set<string>();
  const patterns = new Set(taxonomy.patterns.map((p) => p.toLowerCase()));
  const elements = new Set(taxonomy.elements.map((p) => p.toLowerCase()));
  const flowActions = new Set(taxonomy.flowActions.map((p) => p.toLowerCase()));
  const briefs = new Set(taxonomy.briefs.map((b) => b.id));
  const platforms = new Set(Object.keys(config.platforms));

  for (const product of products) {
    if (seenProducts.has(product.id)) throw new ConfigError(`Дублируется продукт "${product.id}"`);
    seenProducts.add(product.id);

    for (const p of product.platforms) {
      if (!platforms.has(p)) warnings.push(`${product.id}: платформа "${p}" не описана в scrn.config.yaml → platforms`);
    }
    if (!product.environments[config.environment]) {
      warnings.push(`${product.id}: нет окружения "${config.environment}" (есть: ${Object.keys(product.environments).join(', ')})`);
    }

    const flowIds = new Set<string>();
    for (const flow of product.flows) {
      if (flowIds.has(flow.id)) throw new ConfigError(`${product.id}: дублируется flow "${flow.id}"`);
      flowIds.add(flow.id);
      if (flow.brief && briefs.size && !briefs.has(flow.brief)) {
        warnings.push(`${product.id}/${flow.id}: brief "${flow.brief}" нет в taxonomy.yaml → briefs`);
      }
      for (const a of flow.actions) {
        if (!flowActions.has(a.toLowerCase())) warnings.push(`${product.id}/${flow.id}: действие флоу "${a}" не из таксономии`);
      }
      const stepIds = new Set<string>();
      for (const step of flow.steps) {
        if (stepIds.has(step.id)) throw new ConfigError(`${product.id}/${flow.id}: дублируется step "${step.id}"`);
        stepIds.add(step.id);
        for (const p of step.patterns) {
          if (!patterns.has(p.toLowerCase())) warnings.push(`${product.id}/${flow.id}/${step.id}: паттерн "${p}" не из таксономии`);
        }
        for (const e of step.elements) {
          if (!elements.has(e.toLowerCase())) warnings.push(`${product.id}/${flow.id}/${step.id}: элемент "${e}" не из таксономии`);
        }
        const sectionIds = new Set<string>();
        for (const s of step.sections) {
          if (sectionIds.has(s.id)) throw new ConfigError(`${product.id}/${flow.id}/${step.id}: дублируется section "${s.id}"`);
          sectionIds.add(s.id);
        }
      }
    }
  }
  return warnings;
}

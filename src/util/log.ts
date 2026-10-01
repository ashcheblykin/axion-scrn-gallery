import pc from 'picocolors';

export interface Logger {
  info(msg: string): void;
  ok(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  dim(msg: string): void;
  debug(msg: string): void;
}

/** MCP uses stdout for JSON-RPC — loggers used there must write to stderr only. */
export function createLogger(opts: { verbose?: boolean; stream?: NodeJS.WritableStream; silent?: boolean } = {}): Logger {
  const out = opts.stream ?? process.stdout;
  const write = (s: string) => {
    if (!opts.silent) out.write(`${s}\n`);
  };
  return {
    info: (m) => write(m),
    ok: (m) => write(`${pc.green('✓')} ${m}`),
    warn: (m) => write(`${pc.yellow('⚠')} ${m}`),
    error: (m) => write(`${pc.red('✗')} ${m}`),
    dim: (m) => write(pc.dim(m)),
    debug: (m) => {
      if (opts.verbose) write(pc.dim(`· ${m}`));
    },
  };
}

export const silentLogger: Logger = createLogger({ silent: true });

/** Russian plural: plural(5, ['экран', 'экрана', 'экранов']) → "5 экранов". */
export function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const form = mod10 === 1 && mod100 !== 11 ? forms[0] : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? forms[1] : forms[2];
  return `${n} ${form}`;
}

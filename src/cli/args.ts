/**
 * A tiny, hand-rolled argv parser — deliberately not a dependency. Supports:
 *   - a command word (first positional): `jev-evals run ...`
 *   - further positionals: `jev-evals compare a.json b.json`
 *   - `--flag value`, `--flag=value`, and bare boolean `--flag`
 */
export interface ParsedArgs {
  command: string | undefined;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        i++;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        i += 2;
      } else {
        flags[body] = true;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length === 2) {
      // short flags: only -h is recognized, treat as boolean
      flags[arg.slice(1)] = true;
      i += 1;
      continue;
    }
    positionals.push(arg);
    i += 1;
  }

  const command = positionals.shift();
  return { command, positionals, flags };
}

export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return undefined;
  return v;
}

export function flagNumber(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flagString(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`--${name} must be a number, got "${v}"`);
  return n;
}

export function flagBoolean(flags: Record<string, string | boolean>, name: string): boolean {
  const v = flags[name];
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  return v === 'true' || v === '1';
}

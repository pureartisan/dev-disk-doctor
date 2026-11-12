import { spawn, spawnSync } from 'node:child_process';

// less ends a prompt at ":" or "?" outside a conditional, so neither can appear in these.
const PERCENT = '  (%pb\\%)';
/** Longest to shortest. less shows only the END of a prompt that is wider than the terminal, so pick one that fits. */
const PROMPTS = [
  'scroll with arrows or mouse wheel, space = next page, / = search, q = quit',
  'arrows/wheel scroll, space page, / find, q quit',
  'q quit, arrows scroll',
];
/** Columns the percentage takes at its widest: "  (100%)". */
const PERCENT_COLUMNS = 8;

/** The bottom-line help for a terminal `columns` wide: the fullest wording that fits on one row. */
export function promptFor(columns = 80): string {
  const text = PROMPTS.find((t) => t.length + PERCENT_COLUMNS <= columns) ?? PROMPTS[PROMPTS.length - 1]!;
  return `${text}${PERCENT}`;
}

/** Terminal rows the text takes up once long lines wrap. */
export function screenLines(text: string, columns: number): number {
  // eslint-disable-next-line no-control-regex
  return text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.replace(/\x1b\[[0-9;]*m/g, '').length / columns)), 0);
}

/** What the installed `less` can do: wheel scrolling arrived in version 551, `--wheel-lines` later. */
function lessFeatures(): { mouse: boolean; wheelLines: boolean } | undefined {
  const v = spawnSync('less', ['--version'], { encoding: 'utf8' });
  const version = Number(/less (\d+)/.exec(v.stdout ?? '')?.[1]);
  if (v.error || !version) return undefined;
  const help = spawnSync('less', ['--help'], { encoding: 'utf8' }).stdout ?? '';
  return { mouse: version >= 551, wheelLines: help.includes('--wheel-lines') };
}

/**
 * Show `text` in `less` so it can be scrolled with the keyboard or, unless `mouse` is off, the mouse wheel.
 * Resolves false when nothing was shown (the text fits the screen, or `less` is missing), so the caller prints it.
 * With the wheel on, the terminal passes mouse events to `less`, so selecting text needs Option (or Shift) held.
 */
export function page(text: string, opts: { rows?: number; columns?: number; mouse?: boolean } = {}): Promise<boolean> {
  if (opts.rows && screenLines(text, opts.columns ?? 80) < opts.rows) return Promise.resolve(false);
  const features = lessFeatures();
  if (!features) return Promise.resolve(false);
  const args = ['-R', `-Ps${promptFor(opts.columns)}`];
  if (opts.mouse !== false && features.mouse) args.push('--mouse');
  if (opts.mouse !== false && features.mouse && features.wheelLines) args.push('--wheel-lines=3');
  return new Promise((resolve) => {
    const child = spawn('less', args, { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(true));
    // Quitting before the end closes the pipe; that is not an error.
    child.stdin.on('error', () => {});
    child.stdin.end(`${text}\n`);
  });
}

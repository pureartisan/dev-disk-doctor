import { spawn, spawnSync } from 'node:child_process';

const PROMPT = 'scroll: arrows or mouse wheel, space = next page, / = search, q = quit  (%pb\\%)';

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
  const args = ['-R', `-Ps${PROMPT}`];
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

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

export interface Spinner {
  /** Stop animating and wipe the line, so whatever prints next starts clean. Safe to call twice. */
  stop(): void;
}

/** Just enough of a stream for the spinner; process.stderr fits. */
export interface SpinnerStream {
  isTTY?: boolean;
  columns?: number;
  write(text: string): unknown;
}

/**
 * Shorten `message` so the whole spinner line fits on one row. A wrapped line cannot be redrawn in place:
 * `\r\x1b[K` only clears the last row, so every frame would leave the first row behind.
 */
function fit(message: string, room: number): string {
  if (message.length <= room) return message;
  return room > 1 ? `${message.slice(0, room - 1)}…` : message.slice(0, Math.max(room, 0));
}

/**
 * Show `message` with a spinner and the seconds elapsed. On a terminal it animates in place; anywhere else
 * (pipes, CI logs) it prints the message once, so logs do not fill with frames.
 */
export function startSpinner(message: string, stream: SpinnerStream = process.stderr): Spinner {
  if (!stream.isTTY) {
    stream.write(`${message}\n`);
    return { stop: () => {} };
  }
  const t0 = Date.now();
  let frame = 0;
  const draw = () => {
    const secs = Math.floor((Date.now() - t0) / 1000);
    const suffix = secs > 0 ? ` (${secs}s)` : '';
    // Frame and space take 2 columns; keep the last column free so the cursor never wraps.
    const room = stream.columns ? stream.columns - 3 - suffix.length : Infinity;
    stream.write(`\r\x1b[K${FRAMES[frame++ % FRAMES.length]} ${fit(message, room)}${suffix}`);
  };
  draw();
  const timer = setInterval(draw, INTERVAL_MS);
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stream.write('\r\x1b[K');
    },
  };
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

export interface Spinner {
  /** Stop animating and wipe the line, so whatever prints next starts clean. Safe to call twice. */
  stop(): void;
}

/** Just enough of a stream for the spinner; process.stderr fits. */
export interface SpinnerStream {
  isTTY?: boolean;
  write(text: string): unknown;
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
    stream.write(`\r\x1b[K${FRAMES[frame++ % FRAMES.length]} ${message}${secs > 0 ? ` (${secs}s)` : ''}`);
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

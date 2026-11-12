import { sizeOf } from '../core/size.js';
import { isInside, shellQuote } from '../core/util.js';
import type { Action, Category, Finding, Risk, ScanOptions } from '../core/types.js';

export function removeAction(
  findingId: string,
  p: string,
  risk: Risk,
  bytes: number,
  warning?: string,
  label = 'Delete this folder',
): Action {
  return {
    id: `${findingId}#remove`,
    label,
    display: `rm -rf ${shellQuote(p)}`,
    risk,
    kind: { type: 'remove-path', path: p },
    reclaimBytes: bytes,
    warning,
  };
}

export function execAction(
  findingId: string,
  name: string,
  label: string,
  file: string,
  args: string[],
  risk: Risk,
  extra: { bytes?: number; warning?: string; cwd?: string } = {},
): Action {
  return {
    id: `${findingId}#${name}`,
    label,
    display: [file, ...args].map(shellQuote).join(' '),
    risk,
    kind: { type: 'exec', file, args, cwd: extra.cwd },
    reclaimBytes: extra.bytes,
    warning: extra.warning,
  };
}

export function manualAction(
  findingId: string,
  name: string,
  label: string,
  display: string,
  risk: Risk,
  warning?: string,
): Action {
  return { id: `${findingId}#${name}`, label, display, risk, kind: { type: 'manual' }, warning };
}

export interface PathFindingSpec {
  detector: string;
  key: string;
  category: Category;
  title: string;
  path: string;
  risk: Risk;
  regenerable: boolean;
  why: string;
  /** Delete the path itself as the fix. */
  removable?: boolean;
  warning?: string;
  /** Replace the default actions entirely. */
  actions?: (id: string, bytes: number) => Action[];
  meta?: Record<string, unknown>;
}

/** Build a finding for one directory or file, or undefined if absent or below the size floor. */
export async function pathFinding(spec: PathFindingSpec, opts: ScanOptions): Promise<Finding | undefined> {
  const bytes = await sizeOf(spec.path, opts.detectorTimeoutMs);
  if (bytes === undefined || bytes < opts.minBytes) return undefined;
  const id = `${spec.detector}:${spec.key}`;
  const actions = spec.actions
    ? spec.actions(id, bytes)
    : spec.removable === false
      ? []
      : [removeAction(id, spec.path, spec.risk, bytes, spec.warning)];
  return {
    id,
    detector: spec.detector,
    category: spec.category,
    title: spec.title,
    path: spec.path,
    bytes,
    risk: spec.risk,
    regenerable: spec.regenerable,
    why: spec.why,
    actions,
    meta: spec.meta,
  };
}

export async function pathFindings(specs: PathFindingSpec[], opts: ScanOptions): Promise<Finding[]> {
  const out = await Promise.all(specs.map((s) => pathFinding(s, opts)));
  return out.filter((f): f is Finding => f !== undefined);
}

/**
 * Bytes under `p` that earlier findings already explain, counting nested findings once.
 * `count` is how many outermost findings sit inside `p` (or are `p` itself).
 */
export function explainedUnder(p: string, known: Finding[]): { bytes: number; count: number } {
  const inside = known.filter((f) => f.path && f.bytes > 0 && isInside(f.path, p));
  const outer = inside.filter((f) => !inside.some((g) => g !== f && g.path !== f.path && isInside(f.path!, g.path!)));
  return { bytes: outer.reduce((sum, f) => sum + f.bytes, 0), count: outer.length };
}

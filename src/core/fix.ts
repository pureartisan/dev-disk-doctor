import { promises as fs } from 'node:fs';
import path from 'node:path';
import { run } from './exec.js';
import { diskInfo, scan } from './scan.js';
import { isInside } from './util.js';
import type { Action, Finding, ScanOptions } from './types.js';

export interface FixOutcome {
  ok: boolean;
  /** True when nothing was changed (default). */
  dryRun: boolean;
  findingId: string;
  actionId: string;
  /** What ran, or would run. */
  command?: string;
  warning?: string;
  message: string;
  output?: string;
  freedBytes?: number;
}

const PROTECTED_HOME_CHILDREN = new Set(['Documents', 'Desktop', 'Pictures', 'Movies', 'Music', 'Public', 'Applications', 'Library', 'Downloads']);

/** Defence in depth: detectors only ever produce safe paths, but never trust that blindly. */
export function assertSafeToRemove(target: string, opts: Pick<ScanOptions, 'home' | 'roots'>): void {
  if (!path.isAbsolute(target)) throw new Error('Refusing to delete a relative path.');
  const normalized = path.resolve(target);
  if (normalized !== target.replace(/\/+$/, '') && normalized !== target) throw new Error('Refusing to delete a non-normalised path.');
  if (!isInside(normalized, opts.home) || normalized === opts.home) throw new Error('Refusing to delete anything outside your home folder.');
  const rel = path.relative(opts.home, normalized);
  if (PROTECTED_HOME_CHILDREN.has(rel)) throw new Error(`Refusing to delete ~/${rel} itself.`);
  if (opts.roots.some((r) => path.resolve(r) === normalized)) throw new Error('Refusing to delete a workspace root.');
}

export function findAction(findings: Finding[], actionId: string): { finding: Finding; action: Action } | undefined {
  for (const finding of findings) {
    const action = finding.actions.find((a) => a.id === actionId);
    if (action) return { finding, action };
  }
  return undefined;
}

/**
 * Re-scans just the owning detector (so state is fresh), then runs one allowlisted action.
 * Dry run unless `confirm` is true.
 */
export async function applyAction(opts: ScanOptions, actionId: string, confirm = false): Promise<FixOutcome> {
  const hash = actionId.lastIndexOf('#');
  const findingId = hash > 0 ? actionId.slice(0, hash) : actionId;
  const detector = findingId.split(':')[0];
  const base = { dryRun: !confirm, findingId, actionId };

  if (detector === 'biggest') return { ...base, ok: false, dryRun: true, message: 'Findings from the whole-home sweep have no automatic actions.' };

  const result = await scan({ ...opts, only: [detector], minBytes: 0 });
  const hit = findAction(result.findings, actionId);
  if (!hit) {
    return { ...base, ok: false, dryRun: true, message: `No action "${actionId}" exists any more. It may already be done, or the state changed. Run a new scan.` };
  }
  return runAction(opts, hit.finding, hit.action, confirm);
}

/** Runs one action from a fresh scan. Every guard lives here so single and batch fixes cannot diverge. */
async function runAction(opts: ScanOptions, finding: Finding, action: Action, confirm: boolean): Promise<FixOutcome> {
  const base = { dryRun: !confirm, findingId: finding.id, actionId: action.id };
  const common = { command: action.display, warning: action.warning };

  if (action.kind.type === 'manual') return { ...base, ...common, ok: false, dryRun: true, message: 'This one is instructions only; the tool never applies it. Run it yourself if you decide to.' };
  if (action.risk === 'danger' || finding.risk === 'danger') return { ...base, ...common, ok: false, dryRun: true, message: 'Refused: this could lose data that cannot be recovered.' };
  if (!confirm) return { ...base, ...common, ok: true, dryRun: true, message: `Dry run. Would run: ${action.display}. Re-run with --yes (CLI) or confirm: true (MCP) to apply.` };

  const before = await diskInfo(opts.home);
  try {
    let output = '';
    if (action.kind.type === 'remove-path') {
      assertSafeToRemove(action.kind.path, opts);
      await fs.rm(action.kind.path, { recursive: true, force: true, maxRetries: 2 });
    } else {
      const r = await run(action.kind.file, action.kind.args, { cwd: action.kind.cwd, timeoutMs: 15 * 60_000 });
      output = (r.stdout + r.stderr).trim().slice(-4000);
      if (!r.ok) return { ...base, ...common, ok: false, dryRun: false, message: `Command failed${r.timedOut ? ' (timed out)' : ''}.`, output };
    }
    const after = await diskInfo(opts.home);
    const freed = before && after ? Math.max(0, after.freeBytes - before.freeBytes) : undefined;
    return { ...base, ...common, ok: true, dryRun: false, message: 'Done.', output: output || undefined, freedBytes: freed };
  } catch (e) {
    return { ...base, ...common, ok: false, dryRun: false, message: e instanceof Error ? e.message : String(e) };
  }
}

export interface BatchItem {
  title: string;
  bytes: number;
  outcome: FixOutcome;
}

export interface BatchOutcome {
  /** True when nothing was changed (default). */
  dryRun: boolean;
  /** False if any action failed. */
  ok: boolean;
  items: BatchItem[];
  failed: number;
  /** Distinct warnings from the selected actions, to read before confirming. */
  warnings: string[];
  /** Free space gained across the whole run, when it was applied and measurable. */
  freedBytes?: number;
}

/**
 * The actions `fix safe` runs: runnable, and rated safe on both the finding and the action.
 * Review-rated items are never batched; the user picks those one at a time.
 */
export function safeActions(findings: Finding[]): { finding: Finding; action: Action }[] {
  const picked: { finding: Finding; action: Action }[] = [];
  for (const finding of findings) {
    if (finding.risk !== 'safe') continue;
    for (const action of finding.actions) {
      if (action.risk === 'safe' && action.kind.type !== 'manual') picked.push({ finding, action });
    }
  }
  return picked;
}

export interface BatchHooks {
  onPlan?: (plan: { finding: Finding; action: Action }[], warnings: string[]) => void;
  onItem?: (item: BatchItem, index: number, total: number) => void;
}

/** Scans once, then runs every safe action, largest first. A failure does not stop the rest. Dry run unless `confirm`. */
export async function applySafe(opts: ScanOptions, confirm = false, hooks: BatchHooks = {}): Promise<BatchOutcome> {
  const result = await scan(opts);
  const plan = safeActions(result.findings);
  const warnings = [...new Set(plan.flatMap((p) => (p.action.warning ? [p.action.warning] : [])))];
  hooks.onPlan?.(plan, warnings);

  const before = confirm ? await diskInfo(opts.home) : undefined;
  const items: BatchItem[] = [];
  for (const [i, { finding, action }] of plan.entries()) {
    const outcome = await runAction(opts, finding, action, confirm);
    const item = { title: finding.title, bytes: finding.bytes, outcome };
    items.push(item);
    hooks.onItem?.(item, i, plan.length);
  }
  const after = confirm ? await diskInfo(opts.home) : undefined;
  const failed = items.filter((i) => !i.outcome.ok).length;
  return {
    dryRun: !confirm,
    ok: failed === 0,
    items,
    failed,
    warnings,
    freedBytes: before && after ? Math.max(0, after.freeBytes - before.freeBytes) : undefined,
  };
}

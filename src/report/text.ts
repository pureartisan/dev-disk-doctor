import { safeActions, type BatchItem, type BatchOutcome } from '../core/fix.js';
import { fmtBytes, shellQuote } from '../core/util.js';
import type { Action, Finding, Risk, ScanResult } from '../core/types.js';
import type { WorktreeAudit, WorktreeInfo } from '../worktrees/types.js';

export interface Style {
  color: boolean;
}

function paint(style: Style) {
  const c = (code: string) => (s: string) => (style.color ? `\u001b[${code}m${s}\u001b[0m` : s);
  return { bold: c('1'), dim: c('2'), red: c('31'), yellow: c('33'), green: c('32'), cyan: c('36') };
}

const RISK_LABEL: Record<Risk, string> = { safe: 'SAFE', review: 'REVIEW', danger: 'CAREFUL' };

/** What to type to run this tool again: `npx dev-disk-doctor` when launched through npx, else the bare name. */
export function binName(argv1 = process.argv[1] ?? ''): string {
  return argv1.includes('/_npx/') ? 'npx dev-disk-doctor' : 'dev-disk-doctor';
}

/**
 * An action id as one shell word. Double quotes read well and cover almost every id, but a path with `$`, a
 * backtick, `\`, `"` or `!` (history expansion) would be changed by the shell, so those get single quotes.
 */
export function quoteId(id: string): string {
  return /["$`\\!]/.test(id) ? shellQuote(id) : `"${id}"`;
}

/** Actions `fix <id>` can run: anything that is not instructions-only on a finding that is not marked danger. */
function isRunnable(f: Finding, a: Action): boolean {
  return a.kind.type !== 'manual' && a.risk !== 'danger' && f.risk !== 'danger';
}

export function renderScan(r: ScanResult, style: Style, opts: { limit?: number; bin?: string } = {}): string {
  const bin = opts.bin ?? binName();
  const p = paint(style);
  const riskTag = (risk: Risk) => (risk === 'safe' ? p.green : risk === 'review' ? p.yellow : p.red)(`[${RISK_LABEL[risk]}]`);
  const out: string[] = [];

  out.push(p.bold('dev-disk-doctor'));
  if (r.disk) {
    const used = r.disk.totalBytes - r.disk.freeBytes;
    out.push(`Disk: ${fmtBytes(r.disk.totalBytes)} total, ${fmtBytes(used)} used, ${p.bold(fmtBytes(r.disk.freeBytes))} free`);
  }
  out.push(
    `Found ${p.bold(fmtBytes(r.totals.bytes))} across ${r.totals.findings} items; ` +
      `${p.bold(fmtBytes(r.totals.reclaimableBytes))} could be reclaimed with actions this tool can run ` +
      `(${fmtBytes(r.totals.bytesByRisk.safe)} safe, ${fmtBytes(r.totals.bytesByRisk.review)} needs a look, ${fmtBytes(r.totals.bytesByRisk.danger)} careful).`,
  );
  out.push(p.dim(`Searched for projects in: ${r.options.roots.map((x) => x.replace(r.host.home, '~')).join(', ') || 'no workspace folders found (use --root <dir>)'}`));
  out.push('');

  const limit = opts.limit ?? 25;
  const shown = r.findings.slice(0, limit);
  shown.forEach((f, i) => out.push(renderFinding(f, i + 1, p, riskTag, bin)));
  if (r.findings.length > shown.length) out.push(p.dim(`… ${r.findings.length - shown.length} smaller items hidden. Use --all to see everything.`));

  if (r.skipped.length) {
    out.push('');
    for (const s of r.skipped) out.push(p.dim(`Skipped ${s.detector}: ${s.reason}`));
  }
  out.push('');
  const safe = safeActions(r.findings);
  if (safe.length) {
    out.push(`${p.bold('Clean every SAFE item in one go:')} ${safe.length} action${safe.length === 1 ? '' : 's'}. Preview with ${p.cyan(`${bin} fix safe`)}, then add --yes.`);
  }
  out.push(p.dim('Nothing was changed. REVIEW items are never batched: copy the "run:" line under the ones you want.'));
  return out.join('\n');
}

function renderFinding(f: Finding, n: number, p: ReturnType<typeof paint>, tag: (r: Risk) => string, bin: string): string {
  const lines: string[] = [];
  lines.push(`${String(n).padStart(2)}. ${p.bold(fmtBytes(f.bytes).padStart(8))}  ${tag(f.risk)} ${f.title}`);
  lines.push(`    ${p.dim(f.why)}`);
  if (f.path) lines.push(`    ${p.dim(f.path)}`);
  for (const a of f.actions) {
    const mark = a.kind.type === 'manual' ? 'manual' : a.risk === 'safe' ? 'can run' : 'asks first';
    lines.push(`    ${p.cyan('→')} ${a.label} ${p.dim(`(${mark})`)}`);
    lines.push(`      ${p.dim('$')} ${a.display}`);
    if (a.warning) lines.push(`      ${p.yellow('! ' + a.warning)}`);
    if (isRunnable(f, a)) lines.push(`      ${p.dim('run:')} ${p.cyan(`${bin} fix ${quoteId(a.id)} --yes`)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function batchLine(item: BatchItem, index: number, total: number, p: ReturnType<typeof paint>): string {
  const o = item.outcome;
  const head = `${String(index + 1).padStart(String(total).length)}/${total}  ${fmtBytes(item.bytes).padStart(8)}  ${item.title}`;
  if (o.dryRun) return `${p.bold(head)}\n      ${p.dim('$')} ${o.command ?? ''}`;
  if (!o.ok) return `${p.red('✗')} ${p.bold(head)}\n      ${p.red(o.message)}${o.output ? `\n${o.output}` : ''}`;
  const freed = o.freedBytes ? p.dim(` (free space +${fmtBytes(o.freedBytes)})`) : '';
  return `${p.green('✓')} ${p.bold(head)}${freed}`;
}

/** Shown before a batch starts: how many actions and what to check first. */
export function renderBatchPlan(count: number, warnings: string[], dryRun: boolean, style: Style): string {
  const p = paint(style);
  const out = [p.bold(`${dryRun ? 'Dry run: would clean' : 'Cleaning'} ${count} SAFE item${count === 1 ? '' : 's'}`)];
  if (warnings.length) {
    out.push(p.yellow('Check before you run this:'));
    for (const w of warnings) out.push(p.yellow(`  ! ${w}`));
  }
  out.push('');
  return out.join('\n');
}

export function renderBatchItem(item: BatchItem, index: number, total: number, style: Style): string {
  return batchLine(item, index, total, paint(style));
}

export function renderBatchSummary(b: BatchOutcome, style: Style, bin = binName()): string {
  const p = paint(style);
  if (!b.items.length) return 'Nothing safe to clean right now.';
  if (b.dryRun) return `\n${p.dim('Nothing was changed.')} Run ${p.cyan(`${bin} fix safe --yes`)} to do all of the above.`;
  const freed = b.freedBytes !== undefined ? ` Free space changed by ${(b.freedBytes / 1024 ** 3).toFixed(2)} GB.` : '';
  const failed = b.failed ? p.red(` ${b.failed} failed; see ✗ above.`) : '';
  return `\nDone: ${b.items.length - b.failed} of ${b.items.length} cleaned.${failed}${freed}`;
}

const STATUS_ORDER: Record<string, number> = { 'at-risk': 0, stale: 1, prunable: 2, locked: 3, active: 4 };

export function renderWorktrees(a: WorktreeAudit, style: Style, home: string): string {
  const p = paint(style);
  const short = (s: string) => s.replace(home, '~');
  const t = a.totals;
  const out: string[] = [];
  out.push(p.bold('Git worktree audit'));
  out.push(
    `${t.repos} repos found; ${p.bold(String(t.linkedWorktrees))} linked worktrees across ${t.reposWithLinkedWorktrees} of them, using ${fmtBytes(t.bytes)}.`,
  );
  out.push(
    `${t.byStatus.active} active · ${p.yellow(String(t.byStatus.stale))} stale · ${p.red(String(t.byStatus['at-risk']))} at risk · ${t.byStatus.prunable} dangling records · ${t.byStatus.locked} locked · ${t.orphans} orphaned folders`,
  );
  out.push(p.dim(`Searched: ${a.rootsScanned.map(short).join(', ') || '(no workspace roots found; pass --root)'}`));
  out.push('');

  for (const repo of a.repos.filter((r) => r.worktrees.some((w) => !w.isMain))) {
    const linked = repo.worktrees.filter((w) => !w.isMain).sort((x, y) => STATUS_ORDER[x.status] - STATUS_ORDER[y.status] || (y.bytes ?? 0) - (x.bytes ?? 0));
    out.push(p.bold(`${short(repo.repo)}  (${linked.length} linked)`));
    for (const w of linked) out.push(worktreeLine(w, p, short));
    out.push('');
  }
  if (a.orphans.length) {
    out.push(p.bold('Orphaned folders (no repository owns them any more)'));
    for (const o of a.orphans) out.push(`  ${p.yellow('orphan')}  ${fmtBytes(o.bytes ?? 0).padStart(8)}  ${short(o.path)}${o.idleDays !== undefined ? `  idle ${o.idleDays}d` : ''}`);
    out.push('');
  }
  return out.join('\n');
}

function worktreeLine(w: WorktreeInfo, p: ReturnType<typeof paint>, short: (s: string) => string): string {
  const color = w.status === 'at-risk' ? p.red : w.status === 'stale' ? p.yellow : w.status === 'active' ? p.green : p.dim;
  const who = w.toolOwned ? ` ${p.dim('(' + w.toolOwned + ')')}` : '';
  const br = w.branch ?? (w.detached ? 'detached' : '?');
  return `  ${color(w.status.padEnd(8))} ${fmtBytes(w.bytes ?? 0).padStart(8)}  ${short(w.path)} [${br}]${who}\n           ${p.dim(w.reason)}`;
}

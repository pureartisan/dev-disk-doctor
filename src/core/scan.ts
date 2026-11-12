import os from 'node:os';
import { detectors } from '../detectors/index.js';
import { run } from './exec.js';
import { fingerprintOptions } from './fingerprint.js';
import { defaultRoots } from './roots.js';
import { isInside } from './util.js';
import type { DiskInfo, Finding, Risk, ScanOptions, ScanResult } from './types.js';

export async function buildOptions(partial: Partial<ScanOptions> = {}): Promise<ScanOptions> {
  const home = partial.home ?? os.homedir();
  return {
    home,
    platform: partial.platform ?? process.platform,
    roots: partial.roots?.length ? partial.roots : await defaultRoots(home),
    minBytes: partial.minBytes ?? 100 * 1024 * 1024,
    staleDays: partial.staleDays ?? 30,
    deep: partial.deep ?? false,
    only: partial.only,
    detectorTimeoutMs: partial.detectorTimeoutMs ?? 120_000,
  };
}

export async function diskInfo(home: string): Promise<DiskInfo | undefined> {
  const r = await run('df', ['-k', home], { timeoutMs: 10_000 });
  const line = r.stdout.trim().split('\n')[1];
  if (!line) return undefined;
  const cols = line.trim().split(/\s+/);
  const total = Number(cols[1]) * 1024;
  const free = Number(cols[3]) * 1024;
  return Number.isFinite(total) && Number.isFinite(free) ? { totalBytes: total, freeBytes: free } : undefined;
}

/** Drop findings that live inside another finding's folder so nothing is counted twice. */
function outermost(findings: Finding[]): Finding[] {
  const withPath = findings.filter((f) => f.path);
  return findings.filter((f) => {
    if (!f.path) return true;
    return !withPath.some((g) => g !== f && g.path !== f.path && isInside(f.path!, g.path!));
  });
}

export function computeTotals(findings: Finding[]): ScanResult['totals'] {
  // A container such as Docker's disk image holds the other Docker findings; count it only when it stands alone.
  const counted = outermost(findings).filter(
    (f) => !(f.meta?.envelope && findings.some((g) => g !== f && g.detector === f.detector && !g.meta?.envelope && g.bytes > 0)),
  );
  const bytesByRisk: Record<Risk, number> = { safe: 0, review: 0, danger: 0 };
  let bytes = 0;
  let reclaimable = 0;
  for (const f of counted) {
    bytes += f.bytes;
    bytesByRisk[f.risk] += f.bytes;
    if (f.risk !== 'danger') {
      // Only count what an action says it frees; "delete unavailable simulators" etc. do not free the whole folder.
      const runnable = f.actions.filter((a) => a.kind.type !== 'manual' && a.risk !== 'danger');
      reclaimable += Math.max(0, ...runnable.map((a) => a.reclaimBytes ?? 0));
    }
  }
  return { findings: findings.length, bytes, reclaimableBytes: reclaimable, bytesByRisk };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} exceeded ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export async function scan(opts: ScanOptions): Promise<ScanResult> {
  const startedAt = Date.now();
  const findings: Finding[] = [];
  const skipped: ScanResult['skipped'] = [];
  const timings: Record<string, number> = {};

  const selected = detectors.filter((d) => (opts.only ? opts.only.includes(d.id) : true));
  const runOne = async (d: (typeof detectors)[number]) => {
    const t0 = Date.now();
    try {
      const res = await withTimeout(d.run(opts, () => findings), opts.detectorTimeoutMs * 4, d.id);
      findings.push(...res.filter((f) => f.bytes >= opts.minBytes || f.bytes === 0 || f.detector === 'worktrees'));
    } catch (e) {
      skipped.push({ detector: d.id, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      timings[d.id] = Date.now() - t0;
    }
  };

  const quick = selected.filter((d) => !d.deepOnly && !d.late);
  const late = selected.filter((d) => !d.deepOnly && d.late);
  const deep = selected.filter((d) => d.deepOnly);
  await Promise.all(quick.map(runOne));
  // Late detectors run one after another, in order, so each sees the findings of those before it.
  for (const d of late) await runOne(d);
  if (opts.deep || (opts.only && deep.length)) await Promise.all(deep.map(runOne));
  else if (deep.length) skipped.push(...deep.map((d) => ({ detector: d.id, reason: 'Only runs with --deep (slow whole-home sweep).' })));

  findings.sort((a, b) => b.bytes - a.bytes);
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    host: { platform: opts.platform, home: opts.home },
    disk: await diskInfo(opts.home),
    options: { roots: opts.roots, minBytes: opts.minBytes, staleDays: opts.staleDays, deep: opts.deep },
    totals: computeTotals(findings),
    findings,
    skipped,
    timingsMs: timings,
    durationMs: Date.now() - startedAt,
    fingerprint: fingerprintOptions(opts),
  };
}

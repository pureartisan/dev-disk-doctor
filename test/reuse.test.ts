import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { FIX_REUSE_MS, loadMatchingScan, saveScan, scanMatches } from '../src/core/cache.js';
import { fingerprintOptions } from '../src/core/fingerprint.js';
import { applyPlan, recheckPlan, safeActions, type PlanItem } from '../src/core/fix.js';
import { scan } from '../src/core/scan.js';
import type { ScanResult } from '../src/core/types.js';
import { opts, tmp } from './helpers.js';

function write(file: string, text = 'x'): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A project whose node_modules is a SAFE finding (stale straight away with staleDays 0). */
function projectHome(): { home: string; modules: string } {
  const home = tmp();
  write(path.join(home, 'app/package.json'), '{}');
  write(path.join(home, 'app/node_modules/dep/index.js'), 'x'.repeat(2048));
  return { home, modules: path.join(home, 'app/node_modules') };
}

describe('options fingerprint', () => {
  const base = opts('/h', { roots: ['/h/dev', '/h/code'] });

  it('is the same for options that mean the same thing', () => {
    const same = [
      opts('/h', { roots: ['/h/code', '/h/dev'] }),
      opts('/h', { roots: ['/h/dev/', '/h/code', '/h/dev'] }),
      opts('/h', { roots: ['/h/dev', '/h/code'], only: [] }),
      opts('/h', { roots: ['/h/dev', '/h/code'], detectorTimeoutMs: 5 }),
    ];
    for (const o of same) assert.equal(fingerprintOptions(o), fingerprintOptions(base));
    assert.equal(fingerprintOptions(opts('/h', { only: ['docker', 'xcode'] })), fingerprintOptions(opts('/h', { only: ['xcode', 'docker', 'xcode'] })));
  });

  it('changes when anything that decides what is found changes', () => {
    const different = [
      opts('/h', { roots: ['/h/dev'] }),
      opts('/h', { roots: ['/h/dev', '/h/code'], minBytes: 1 }),
      opts('/h', { roots: ['/h/dev', '/h/code'], staleDays: 99 }),
      opts('/h', { roots: ['/h/dev', '/h/code'], deep: true }),
      opts('/h', { roots: ['/h/dev', '/h/code'], only: ['docker'] }),
      opts('/other', { roots: ['/h/dev', '/h/code'] }),
      opts('/h', { roots: ['/h/dev', '/h/code'], platform: process.platform === 'linux' ? 'darwin' : 'linux' }),
    ];
    for (const o of different) assert.notEqual(fingerprintOptions(o), fingerprintOptions(base));
  });
});

describe('reusing a saved scan', () => {
  const o = opts('/h');
  const now = Date.parse('2026-11-12T10:00:00Z');
  const made = (secondsAgo: number, over: Partial<ScanResult> = {}): ScanResult =>
    ({ schema: 1, generatedAt: new Date(now - secondsAgo * 1000).toISOString(), fingerprint: fingerprintOptions(o), findings: [], ...over }) as unknown as ScanResult;

  it('matches only a recent scan made with the same options', () => {
    assert.ok(scanMatches(made(10), o, FIX_REUSE_MS, now));
    assert.ok(scanMatches(made(299), o, FIX_REUSE_MS, now));
    assert.ok(!scanMatches(made(301), o, FIX_REUSE_MS, now), 'older than five minutes');
    assert.ok(!scanMatches(made(-60), o, FIX_REUSE_MS, now), 'dated in the future');
    assert.ok(!scanMatches(made(10), opts('/h', { deep: true }), FIX_REUSE_MS, now), 'other options');
    assert.ok(!scanMatches(made(10, { fingerprint: undefined }), o, FIX_REUSE_MS, now), 'saved before fingerprints existed');
    assert.ok(scanMatches(made(86_400), o, Infinity, now), 'with no age limit, age does not matter (what show does)');
  });

  it('loads the saved scan only when the options match', async () => {
    const { home } = projectHome();
    const o2 = opts(home, { staleDays: 0 });
    await saveScan(home, await scan(o2));
    assert.ok(await loadMatchingScan(o2, FIX_REUSE_MS), 'same options');
    assert.equal(await loadMatchingScan({ ...o2, roots: [path.join(home, 'app')] }, FIX_REUSE_MS), undefined, 'other folders');
    assert.equal(await loadMatchingScan({ ...o2, minBytes: 10 ** 9 }, FIX_REUSE_MS), undefined, 'other size threshold');
    assert.equal(await loadMatchingScan(o2, FIX_REUSE_MS, Date.now() + FIX_REUSE_MS + 1000), undefined, 'too old');
  });
});

describe('re-checking a plan before it runs', () => {
  async function planFor(): Promise<{ o: ReturnType<typeof opts>; plan: PlanItem[]; modules: string; scannedAt: string }> {
    const { home, modules } = projectHome();
    const o = opts(home, { staleDays: 0, only: ['projects'] });
    const found = await scan(o);
    const plan = safeActions(found.findings);
    assert.equal(plan.length, 1, 'the stale node_modules is on offer');
    return { o, plan, modules, scannedAt: found.generatedAt };
  }

  it('keeps an item that is still on offer', async () => {
    const { o, plan } = await planFor();
    const checked = await recheckPlan(o, plan);
    assert.equal(checked.plan.length, 1);
    assert.equal(checked.dropped.length, 0);
    assert.notEqual(checked.plan[0], plan[0], 'the kept item comes from the fresh look');
  });

  it('drops an item that is gone', async () => {
    const { o, plan, modules } = await planFor();
    rmSync(modules, { recursive: true });
    const checked = await recheckPlan(o, plan);
    assert.equal(checked.plan.length, 0);
    assert.equal(checked.dropped.length, 1);
  });

  it('drops an item that has become riskier', async () => {
    const { o, plan } = await planFor();
    // The project is active again: node_modules is now a REVIEW item, no longer one `fix safe` may run.
    const checked = await recheckPlan({ ...o, staleDays: 100_000 }, plan);
    assert.equal(checked.plan.length, 0);
    assert.equal(checked.dropped.length, 1);
  });

  it('applyPlan re-checks a plan from an old scan, and reports what it left out', async () => {
    const { o, plan, modules } = await planFor();
    rmSync(modules, { recursive: true });
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    let dropped = 0;
    const done = await applyPlan(o, plan, true, { onDropped: (d) => void (dropped = d.length) }, old);
    assert.equal(dropped, 1);
    assert.equal(done.items.length, 0, 'nothing was run');
  });

  it('applyPlan runs a plan from an old scan when nothing changed', async () => {
    const { o, plan, modules } = await planFor();
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    const done = await applyPlan(o, plan, true, {}, old);
    assert.equal(done.items.length, 1);
    assert.ok(done.ok);
    assert.ok(!existsSync(modules));
  });

  it('applyPlan does not re-check a scan from the last minute, or a dry run', async () => {
    const { o, plan, modules, scannedAt } = await planFor();
    rmSync(modules, { recursive: true });
    let dropped = 0;
    const hooks = { onDropped: (d: PlanItem[]) => void (dropped = d.length) };
    await applyPlan(o, plan, true, hooks, scannedAt);
    assert.equal(dropped, 0, 'a scan taken just now is trusted');
    await applyPlan(o, plan, false, hooks, new Date(Date.now() - 10 * 60_000).toISOString());
    assert.equal(dropped, 0, 'a dry run changes nothing, so there is nothing to protect');
  });
});

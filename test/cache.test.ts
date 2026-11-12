import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { clearScan, describeAge, loadScan, saveScan, scanCachePath } from '../src/core/cache.js';
import type { Finding, ScanResult } from '../src/core/types.js';
import { page, promptFor, screenLines } from '../src/report/pager.js';
import { fmtDuration } from '../src/core/util.js';
import { renderScan } from '../src/report/text.js';
import { tmp } from './helpers.js';

function finding(n: number): Finding {
  return { id: `x:${n}`, detector: 'projects', title: `Item ${n}`, bytes: (100 - n) * 1024 * 1024, risk: 'review', why: 'because', actions: [] } as unknown as Finding;
}

function result(count: number): ScanResult {
  const findings = Array.from({ length: count }, (_, i) => finding(i + 1));
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    host: { platform: 'darwin', home: '/h' },
    options: { roots: [], minBytes: 0, staleDays: 30, deep: false },
    totals: { findings: count, bytes: 0, reclaimableBytes: 0, bytesByRisk: { safe: 0, review: 0, danger: 0 } },
    findings,
    skipped: [],
    timingsMs: {},
  };
}

describe('saved scan', () => {
  it('round-trips, and clearing it leaves nothing to load', async () => {
    const home = tmp();
    assert.equal(await loadScan(home), undefined);
    const r = result(3);
    await saveScan(home, r);
    assert.deepEqual(await loadScan(home), r);
    assert.deepEqual(readdirSync(path.dirname(scanCachePath(home))), ['last-scan.json'], 'no temp file left behind');
    await clearScan(home);
    assert.equal(existsSync(scanCachePath(home)), false);
    await clearScan(home);
  });

  it('treats a damaged or foreign file as no cache', async () => {
    const home = tmp();
    await saveScan(home, result(1));
    writeFileSync(scanCachePath(home), '{ not json');
    assert.equal(await loadScan(home), undefined);
    writeFileSync(scanCachePath(home), JSON.stringify({ schema: 2, findings: [], generatedAt: 'x' }));
    assert.equal(await loadScan(home), undefined);
  });

  it('describes its age in plain words', () => {
    const now = Date.parse('2026-01-10T12:00:00Z');
    const ago = (ms: number) => describeAge(new Date(now - ms).toISOString(), now);
    assert.equal(ago(10_000), 'moments ago');
    assert.equal(ago(12 * 60_000), '12 min ago');
    assert.equal(ago(3 * 3_600_000), '3 h ago');
    assert.equal(ago(5 * 86_400_000), '5 days ago');
  });
});

describe('paging a scan', () => {
  const style = { color: false };

  it('numbers items from the offset and says where to continue', () => {
    const out = renderScan(result(10), style, { limit: 3, offset: 3, moreHint: 'Use --from 7.' });
    assert.match(out, /^ 4\. .*Item 4/m);
    assert.match(out, /^ 6\. .*Item 6/m);
    assert.doesNotMatch(out, /Item 3\b/);
    assert.doesNotMatch(out, /Item 7\b/);
    assert.match(out, /4 more items hidden\. Use --from 7\./);
  });

  it('keeps the original wording for the first page and uses the hint when given', () => {
    assert.match(renderScan(result(30), style), /5 smaller items hidden\. Use --all to see everything\./);
    assert.match(renderScan(result(30), style, { moreHint: 'Run show.' }), /5 smaller items hidden\. Run show\./);
  });

  it('names show and --all in the footer when items are hidden, and not when everything fits', () => {
    const out = renderScan(result(30), style, { footerHint: true, bin: 'dev-disk-doctor' });
    assert.match(out, /Showing 25 of 30 items\. dev-disk-doctor show scrolls through all of them .*dev-disk-doctor --all prints them here\./);
    assert.doesNotMatch(renderScan(result(5), style, { footerHint: true }), /Showing \d+ of/);
    assert.doesNotMatch(renderScan(result(30), style), /Showing \d+ of/);
  });

  it('paints the hints light blue when colour is on', () => {
    const out = renderScan(result(30), { color: true }, { footerHint: true });
    // eslint-disable-next-line no-control-regex
    const lightBlue = /\x1b\[(1;)?96m/;
    assert.match(out.split('\n').find((l) => l.includes('items hidden')) ?? '', lightBlue);
    assert.match(out.split('\n').find((l) => l.includes('Showing 25 of 30')) ?? '', lightBlue);
  });

  it('ends with how long the scan took, when it was recorded', () => {
    const out = renderScan({ ...result(3), durationMs: 42_400 }, style).split('\n');
    assert.equal(out.at(-1), 'Scan took 42s.');
    assert.doesNotMatch(renderScan(result(3), style), /Scan took/);
  });

  it('says so when the offset is past the end', () => {
    assert.match(renderScan(result(4), style, { offset: 9 }), /Nothing at item 10: there are only 4\./);
  });

  it('counts wrapped lines and leaves short text to the caller to print', async () => {
    assert.equal(screenLines('a\n\x1b[1mb\x1b[0m', 80), 2);
    assert.equal(screenLines('x'.repeat(170), 80), 3);
    assert.equal(await page('one\ntwo', { rows: 24, columns: 80 }), false);
  });

  it('reports when the pager is not available', async () => {
    const saved = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      assert.equal(await page('hello'), false);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe('pager prompt', () => {
  it('has none of the characters less reads as prompt syntax, which would cut the help text short', () => {
    // less ends a prompt at ":" or "?" outside a conditional, so "scroll: arrows ..." showed only "scroll".
    for (const columns of [30, 50, 60, 80, 100, 200]) assert.doesNotMatch(promptFor(columns).replace('%pb\\%', ''), /[:?.]/);
  });

  it('uses the fullest wording that fits on one row, since less shows only the end of a prompt that is too wide', () => {
    const shown = (columns: number) => promptFor(columns).replace('%pb\\%', '100%');
    assert.match(promptFor(100), /^scroll with arrows or mouse wheel/);
    for (const columns of [58, 70, 80, 100, 140]) assert.ok(shown(columns).length <= columns, `fits ${columns} columns: "${shown(columns)}"`);
    assert.ok(promptFor(53).startsWith('q quit') || promptFor(53).startsWith('arrows/wheel'), 'a narrow pane gets a shorter line');
    assert.ok(shown(53).length <= 53, 'fits the 53-column pane it was reported on');
    for (const columns of [30, 53, 80, 100]) assert.match(promptFor(columns), /q (= )?quit/);
  });

  it('falls back to the default width when the terminal width is unknown', () => {
    assert.equal(promptFor(undefined), promptFor(80));
  });
});

describe('fmtDuration', () => {
  it('reads as seconds, then minutes', () => {
    assert.equal(fmtDuration(800), '0.8s');
    assert.equal(fmtDuration(9_940), '9.9s');
    assert.equal(fmtDuration(42_400), '42s');
    assert.equal(fmtDuration(72_000), '1m 12s');
    assert.equal(fmtDuration(Number.NaN), '0s');
  });
});

#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { FIX_REUSE_MS, clearScan, describeAge, loadMatchingScan, saveScan } from './core/cache.js';
import { addCustomCache, addSavedRoot, configPath, listCustomCaches, removeCustomCache, removeSavedRoot, resetConfig, saveAutoDiscover } from './core/config.js';
import { applyAction, applyPlan, applySafe, runnableActions } from './core/fix.js';
import { buildOptions, scan } from './core/scan.js';
import { version } from './core/version.js';
import type { ScanOptions, ScanResult } from './core/types.js';
import { expandHome } from './core/util.js';
import { buildRows, runPicker, selectedPlan } from './picker.js';
import { askRoots, type Io } from './prompt.js';
import { page } from './report/pager.js';
import { startSpinner } from './report/spinner.js';
import { binName, renderBatchItem, renderBatchPlan, renderBatchSummary, renderFreedSpace, renderScan, renderWorktrees } from './report/text.js';
import { auditWorktrees } from './worktrees/audit.js';

const SCANNING = 'Scanning (read-only)… this can take a minute on a big disk.';

const HELP = `dev-disk-doctor: find out why your developer machine's disk is full

Usage
  dev-disk-doctor [scan]            Scan for space hogs (read-only)
  dev-disk-doctor show              Scroll through the last scan without scanning again (scans first if none is saved)
  dev-disk-doctor worktrees         Audit git worktrees across all your repos (read-only)
  dev-disk-doctor fix               Pick what to clean from a checklist (SAFE items ticked, REVIEW items not)
  dev-disk-doctor fix <action-id>   Show what an action would do; add --yes to run it
  dev-disk-doctor fix safe          Same, for every SAFE item at once (add --yes to run them)
  dev-disk-doctor roots             Show which workspace folders will be searched
  dev-disk-doctor roots add <dir>   Remember a workspace folder for next time (~/.dev-disk-doctor/config)
  dev-disk-doctor roots remove <dir>  Forget a saved workspace folder
  dev-disk-doctor roots auto        Always figure the folders out (stops the first-run question)
  dev-disk-doctor roots reset       Forget every saved choice and ask again next time
  dev-disk-doctor caches            List the caches you added yourself
  dev-disk-doctor caches add <path> Add a cache folder the built-in list does not know (--label, --risk)
  dev-disk-doctor caches remove <path>  Forget one you added
  dev-disk-doctor mcp              Start the MCP server on stdio (for AI agents)

Options
  --json                 Machine-readable output (stable schema)
  --root <dir>           Workspace folder to search for projects and repos (repeatable).
                         Default: ~/dev ~/code ~/src ... plus any other folder directly under
                         your home that contains a git repo (e.g. ~/acme). Also settable with
                         DEV_DISK_DOCTOR_ROOTS=/path/a:/path/b, or saved with "roots add <dir>".
                         Order: --root, then the env var, then saved folders, then auto-discovery.
                         The first time, in a terminal, you are asked which to use. Run "roots" to see the result.
  --min-size <MB>        Ignore items smaller than this (default 100)
  --stale-days <n>       Days idle before a project or worktree counts as stale (default 30)
  --only <detector>      Run one detector (docker, android, xcode, pkgcaches, devcaches, browsers,
                         models, projects, worktrees, system, custom, discovery, biggest). Repeatable.
  --label <text>         With "caches add": a name to show for the folder
  --risk <safe|review>   With "caches add": safe if the tool rebuilds it (deletable by "fix safe"),
                         review (default) if you want to look first
  --deep                 Also sweep your whole home folder for unknown space hogs (slow)
  --all                  Show every finding instead of the top 25
  --from <n>             With "show": start at item n (1 is the biggest)
  --count <n>            With "show": list n items
  --force                With "show": throw away the saved scan and scan again. With "fix" (no id, or safe):
                         scan again instead of reusing a scan from the last five minutes
  --no-pager             With "show": print instead of opening a scrollable view (also the case when piped)
  --no-mouse             With "show": keyboard scrolling only, so the terminal keeps handling text selection
  --yes                  With "fix": actually run the action
  --no-color             Plain output
  -v, --version          Print the version

Each text scan is saved to ~/.dev-disk-doctor/last-scan.json. "show" lists it again; "fix" (checklist or safe) reuses it for five minutes when it was made with the same options, and checks the chosen items again before running them if it is over a minute old.
Nothing is deleted unless you run "fix <id> --yes" or "fix safe --yes". REVIEW items are only run
one at a time, by id. Actions marked CAREFUL are never run by the tool.`;

interface Parsed {
  command: string;
  positional: string[];
  json: boolean;
  roots: string[];
  minMb?: number;
  staleDays?: number;
  only: string[];
  label?: string;
  risk?: 'safe' | 'review';
  deep: boolean;
  all: boolean;
  yes: boolean;
  force: boolean;
  pager: boolean;
  mouse: boolean;
  from?: number;
  count?: number;
  color: boolean;
}

function positiveInt(flag: string, v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a whole number of 1 or more.`);
  return n;
}

function parse(argv: string[]): Parsed {
  const p: Parsed = { command: 'scan', positional: [], json: false, roots: [], only: [], deep: false, all: false, yes: false, force: false, pager: true, mouse: true, color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR };
  const args = [...argv];
  const need = (flag: string) => {
    const v = args.shift();
    if (v === undefined) throw new Error(`${flag} needs a value`);
    return v;
  };
  let first = true;
  while (args.length) {
    const a = args.shift()!;
    if (a === '--json') p.json = true;
    else if (a === '--root') p.roots.push(need(a));
    else if (a === '--min-size') p.minMb = Number(need(a));
    else if (a === '--stale-days') p.staleDays = Number(need(a));
    else if (a === '--only') p.only.push(need(a));
    else if (a === '--label') p.label = need(a);
    else if (a === '--risk') {
      const v = need(a);
      if (v !== 'safe' && v !== 'review') throw new Error('--risk must be safe or review.');
      p.risk = v;
    }
    else if (a === '--deep') p.deep = true;
    else if (a === '--all') p.all = true;
    else if (a === '--from') p.from = positiveInt(a, need(a));
    else if (a === '--count') p.count = positiveInt(a, need(a));
    else if (a === '--force') p.force = true;
    else if (a === '--no-pager') p.pager = false;
    else if (a === '--no-mouse') p.mouse = false;
    else if (a === '--yes' || a === '-y') p.yes = true;
    else if (a === '--no-color') p.color = false;
    else if (a === '-h' || a === '--help' || a === 'help') p.command = 'help';
    else if (a === '-v' || a === '--version') p.command = 'version';
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}. Try --help.`);
    else if (first) p.command = a;
    else p.positional.push(a);
    first = false;
  }
  return p;
}

async function options(p: Parsed): Promise<ScanOptions> {
  const home = process.env.HOME ?? '';
  return buildOptions({
    roots: p.roots.map((r) => path.resolve(expandHome(r, home))),
    minBytes: p.minMb !== undefined ? p.minMb * 1024 * 1024 : undefined,
    staleDays: p.staleDays,
    deep: p.deep,
    only: p.only.length ? p.only : undefined,
  });
}

/** Ask the first-run question on a real terminal. Prompts go to stderr so stdout stays clean for output. */
function terminalIo(): { io: Io; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const abort = new AbortController();
  rl.on('close', () => abort.abort());
  rl.on('SIGINT', () => {
    rl.close();
    process.exit(130);
  });
  return {
    io: {
      say: (text) => console.error(text),
      ask: (question) => rl.question(question, { signal: abort.signal }),
    },
    close: () => rl.close(),
  };
}

/**
 * When nothing says where to look (no --root, no env var, no saved folders, no earlier choice) and a person
 * is at the terminal, ask once. Never asks for --json, piped output, or the MCP server.
 */
async function askRootsIfNeeded(p: Parsed): Promise<void> {
  if (p.json || p.roots.length) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) return;
  const { io, close } = terminalIo();
  try {
    p.roots = (await askRoots(io, os.homedir())).roots;
  } finally {
    close();
  }
}

async function scanWithSpinner(p: Parsed, opts: ScanOptions): Promise<ScanResult> {
  const spinner = p.json ? undefined : startSpinner(SCANNING);
  try {
    return await scan(opts);
  } finally {
    spinner?.stop();
  }
}

/**
 * For "fix": the saved scan when it is under five minutes old and was made with these same options, so a scan you
 * just looked at is not repeated; otherwise a new scan, saved for the next run. "--force" always scans again.
 */
async function recentScanOrScan(p: Parsed, opts: ScanOptions): Promise<ScanResult> {
  if (!p.force) {
    const saved = await loadMatchingScan(opts, FIX_REUSE_MS);
    if (saved) {
      if (!p.json) console.log(`Using the scan taken ${describeAge(saved.generatedAt)} (add --force to scan again).`);
      return saved;
    }
  }
  const result = await scanWithSpinner(p, opts);
  if (!p.json) await saveScan(opts.home, result);
  return result;
}

/** One line per item that `fix` left out because it changed since the scan. */
function reportDropped(dropped: { finding: { title: string } }[]): void {
  console.log(`Left out ${dropped.length} item${dropped.length === 1 ? '' : 's'} that changed since the scan:`);
  for (const d of dropped) console.log(`  - ${d.finding.title}`);
}

async function main(): Promise<void> {
  const p = parse(process.argv.slice(2));
  switch (p.command) {
    case 'help':
      console.log(HELP);
      return;
    case 'version':
      console.log(version());
      return;
    case 'mcp': {
      const { startMcp } = await import('./mcp.js');
      await startMcp();
      return;
    }
    case 'roots': {
      const [sub, ...dirs] = p.positional;
      if (sub === 'add' || sub === 'remove') {
        if (!dirs.length) throw new Error(`roots ${sub} needs a folder, e.g. dev-disk-doctor roots ${sub} ~/Documents/GitHub`);
        const home = os.homedir();
        let saved: string[] = [];
        for (const d of dirs) saved = sub === 'add' ? await addSavedRoot(home, d) : await removeSavedRoot(home, d);
        if (p.json) console.log(JSON.stringify({ saved, config: configPath(home) }, null, 2));
        else if (saved.length) console.log(`${sub === 'add' ? 'Saved' : 'Removed'}. These folders are searched from now on (${configPath(home)}):\n${saved.join('\n')}`);
        else console.log('No saved folders left. Folders are auto-discovered again.');
        return;
      }
      if (sub === 'auto') {
        await saveAutoDiscover(os.homedir());
        console.log('Remembered: folders are figured out automatically, and the first-run question is not asked again.');
        return;
      }
      if (sub === 'reset') {
        await resetConfig(os.homedir());
        console.log(`Removed ${configPath(os.homedir())}. You will be asked where to look the next time you run a scan.`);
        return;
      }
      if (sub !== undefined) throw new Error(`Unknown roots command "${sub}". Use: roots, roots add <dir>, roots remove <dir>, roots auto, roots reset.`);
      const opts = await options(p);
      if (p.json) console.log(JSON.stringify({ roots: opts.roots }, null, 2));
      else if (opts.roots.length) console.log(opts.roots.join('\n'));
      else console.log('No workspace folders found under your home. Pass --root <dir>, set DEV_DISK_DOCTOR_ROOTS, or run "roots add <dir>".');
      return;
    }
    case 'caches': {
      const [sub, ...paths] = p.positional;
      const home = os.homedir();
      if (sub === 'add' || sub === 'remove') {
        if (!paths.length) throw new Error(`caches ${sub} needs a folder, e.g. dev-disk-doctor caches ${sub} ~/.cache/my-tool`);
        if (sub === 'add' && paths.length > 1 && p.label) throw new Error('--label names one folder; add them one at a time.');
        for (const d of paths) sub === 'add' ? await addCustomCache(home, d, { label: p.label, risk: p.risk }) : await removeCustomCache(home, d);
        console.log(sub === 'add' ? `Added. It shows up in the next scan; "fix" can delete it only if you marked it --risk safe, and always asks first without --yes.` : 'Removed.');
        return;
      }
      if (sub !== undefined) throw new Error(`Unknown caches command "${sub}". Use: caches, caches add <path>, caches remove <path>.`);
      const list = await listCustomCaches(home);
      if (p.json) console.log(JSON.stringify({ caches: list }, null, 2));
      else if (!list.length) console.log(`No caches added yet. Add one with: dev-disk-doctor caches add ~/.cache/my-tool --label "My tool" --risk safe\n(Stored in ${configPath(home)}.)`);
      else for (const c of list) console.log(`${c.risk.padEnd(6)} ${c.path}${c.label ? `  (${c.label})` : ''}${c.problem ? `  [ignored: ${c.problem}]` : ''}`);
      return;
    }
    case 'scan': {
      await askRootsIfNeeded(p);
      const opts = await options(p);
      const result = await scanWithSpinner(p, opts);
      if (!p.json) await saveScan(opts.home, result);
      console.log(p.json ? JSON.stringify(result, null, 2) : renderScan(result, { color: p.color }, { limit: p.all ? Infinity : 25, footerHint: true }));
      return;
    }
    case 'show': {
      if (p.force) await clearScan(os.homedir());
      // A saved scan of any age is shown, but only if it answers the same question: same folders, thresholds and detectors.
      let opts = await options(p);
      let result = await loadMatchingScan(opts);
      const saved = Boolean(result);
      if (!result) {
        await askRootsIfNeeded(p);
        opts = await options(p);
        result = await scanWithSpinner(p, opts);
        await saveScan(opts.home, result);
      }
      if (p.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const interactive = p.pager && Boolean(process.stdout.isTTY);
      const offset = (p.from ?? 1) - 1;
      const limit = p.count ?? (p.all || interactive ? Infinity : 25);
      const next = offset + limit + 1;
      const moreHint = `Use --from ${next} for the next ones, or --all.`;
      const age = saved ? `From the scan taken ${describeAge(result.generatedAt)}. Sizes may have changed; run "${binName()} show --force" to scan again.` : 'Scanned just now.';
      const text = `${age}\n${renderScan(result, { color: p.color }, { limit, offset, moreHint })}`;
      if (!(interactive && (await page(text, { rows: process.stdout.rows, columns: process.stdout.columns, mouse: p.mouse })))) console.log(text);
      return;
    }
    case 'worktrees': {
      await askRootsIfNeeded(p);
      const opts = await options(p);
      const spinner = p.json ? undefined : startSpinner('Auditing worktrees (read-only)…');
      let audit;
      try {
        audit = await auditWorktrees(opts);
      } finally {
        spinner?.stop();
      }
      console.log(p.json ? JSON.stringify(audit, null, 2) : renderWorktrees(audit, { color: p.color }, opts.home));
      return;
    }
    case 'fix': {
      const id = p.positional[0];
      if (!id || id === 'pick') {
        if (p.json || !process.stdin.isTTY || !process.stdout.isTTY) {
          throw new Error(`fix needs an action id, e.g. ${binName()} fix "docker:build-cache#prune", or "safe" to clean every SAFE item. In a terminal, "fix" alone opens a checklist.`);
        }
        await askRootsIfNeeded(p);
        const pickOpts = await options(p);
        const style = { color: p.color };
        const found = await recentScanOrScan(p, pickOpts);
        const rows = buildRows(runnableActions(found.findings));
        if (!rows.length) {
          console.log('Nothing this tool can clean right now.');
          return;
        }
        const chosen = await runPicker(rows, { stdin: process.stdin, stdout: process.stdout }, style);
        if (!chosen) {
          console.log('Cancelled. Nothing was changed.');
          return;
        }
        const done = await applyPlan(pickOpts, selectedPlan(rows, chosen), true, {
          onPlan: (items, warnings) => console.log(renderBatchPlan(items.length, warnings, false, style, 'selected item')),
          onItem: (item, i, total) => console.log(renderBatchItem(item, i, total, style)),
          onDropped: reportDropped,
        }, found.generatedAt);
        await clearScan(pickOpts.home);
        console.log(renderBatchSummary(done, style));
        if (!done.ok) process.exitCode = 1;
        return;
      }
      const opts = await options(p);
      if (id === 'safe') {
        const text = !p.json;
        const style = { color: p.color };
        const found = await recentScanOrScan(p, opts);
        const batch = await applySafe(
          opts,
          p.yes,
          {
            onDropped: (dropped) => text && reportDropped(dropped),
            onPlan: (plan, warnings) => {
              if (text && plan.length) console.log(renderBatchPlan(plan.length, warnings, !p.yes, style));
            },
            onItem: (item, i, total) => text && console.log(renderBatchItem(item, i, total, style)),
          },
          found,
        );
        if (p.yes) await clearScan(opts.home);
        console.log(p.json ? JSON.stringify(batch, null, 2) : renderBatchSummary(batch, style));
        if (!batch.ok) process.exitCode = 1;
        return;
      }
      const res = await applyAction(opts, id, p.yes);
      if (p.yes && !res.dryRun) await clearScan(opts.home);
      if (p.json) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(res.message);
        if (res.command) console.log(`$ ${res.command}`);
        if (res.warning) console.log(`! ${res.warning}`);
        if (res.output) console.log(res.output);
        if (res.freedBytes !== undefined && !res.dryRun) console.log(renderFreedSpace(res.freedBytes, { color: p.color }));
      }
      if (!res.ok) process.exitCode = 1;
      return;
    }
    default:
      throw new Error(`Unknown command "${p.command}". Try --help.`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

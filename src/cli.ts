#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { addCustomCache, addSavedRoot, configPath, listCustomCaches, removeCustomCache, removeSavedRoot, resetConfig, saveAutoDiscover } from './core/config.js';
import { applyAction, applySafe } from './core/fix.js';
import { buildOptions, scan } from './core/scan.js';
import { version } from './core/version.js';
import type { ScanOptions } from './core/types.js';
import { expandHome } from './core/util.js';
import { askRoots, type Io } from './prompt.js';
import { startSpinner } from './report/spinner.js';
import { binName, renderBatchItem, renderBatchPlan, renderBatchSummary, renderScan, renderWorktrees } from './report/text.js';
import { auditWorktrees } from './worktrees/audit.js';

const SCANNING = 'Scanning (read-only)… this can take a minute on a big disk.';

const HELP = `dev-disk-doctor: find out why your developer machine's disk is full

Usage
  dev-disk-doctor [scan]            Scan for space hogs (read-only)
  dev-disk-doctor worktrees         Audit git worktrees across all your repos (read-only)
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
  --yes                  With "fix": actually run the action
  --no-color             Plain output
  -v, --version          Print the version

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
  color: boolean;
}

function parse(argv: string[]): Parsed {
  const p: Parsed = { command: 'scan', positional: [], json: false, roots: [], only: [], deep: false, all: false, yes: false, color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR };
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
      const spinner = p.json ? undefined : startSpinner(SCANNING);
      let result;
      try {
        result = await scan(opts);
      } finally {
        spinner?.stop();
      }
      console.log(p.json ? JSON.stringify(result, null, 2) : renderScan(result, { color: p.color }, { limit: p.all ? Infinity : 25 }));
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
      if (!id) throw new Error(`fix needs an action id, e.g. ${binName()} fix "docker:build-cache#prune", or "safe" to clean every SAFE item`);
      const opts = await options(p);
      if (id === 'safe') {
        const text = !p.json;
        const style = { color: p.color };
        const spinner = text ? startSpinner(SCANNING) : undefined;
        let batch;
        try {
          batch = await applySafe(opts, p.yes, {
            onPlan: (plan, warnings) => {
              spinner?.stop();
              if (text && plan.length) console.log(renderBatchPlan(plan.length, warnings, !p.yes, style));
            },
            onItem: (item, i, total) => text && console.log(renderBatchItem(item, i, total, style)),
          });
        } finally {
          spinner?.stop();
        }
        console.log(p.json ? JSON.stringify(batch, null, 2) : renderBatchSummary(batch, style));
        if (!batch.ok) process.exitCode = 1;
        return;
      }
      const res = await applyAction(opts, id, p.yes);
      if (p.json) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(res.message);
        if (res.command) console.log(`$ ${res.command}`);
        if (res.warning) console.log(`! ${res.warning}`);
        if (res.output) console.log(res.output);
        if (res.freedBytes !== undefined && !res.dryRun) console.log(`Free space changed by ${(res.freedBytes / 1024 ** 3).toFixed(2)} GB.`);
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

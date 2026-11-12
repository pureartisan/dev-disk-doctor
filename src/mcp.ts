#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { applyAction, findAction } from './core/fix.js';
import { buildOptions, scan } from './core/scan.js';
import { fmtBytes } from './core/util.js';
import { version } from './core/version.js';
import { auditWorktrees } from './worktrees/audit.js';
import { auditToFindings } from './worktrees/detector.js';

const text = (summary: string, data: unknown) => ({
  content: [
    { type: 'text' as const, text: summary },
    { type: 'text' as const, text: JSON.stringify(data) },
  ],
});

const scanShape = {
  roots: z.array(z.string()).optional().describe('Workspace folders to search for projects and repos. Default: folders saved with `dev-disk-doctor roots add`, else ~/dev, ~/code, ~/src, ~/projects, ~/work… whichever exist.'),
  min_size_mb: z.number().optional().describe('Ignore items smaller than this. Default 100.'),
  stale_days: z.number().optional().describe('Days idle before a project or worktree is stale. Default 30.'),
};

export async function startMcp(): Promise<void> {
  const server = new McpServer({ name: 'dev-disk-doctor', version: version() });

  server.registerTool(
    'disk_scan',
    {
      title: 'Scan for disk space hogs',
      description:
        'Read-only scan of a developer machine for what is using disk space: Docker, Android SDK/emulators, Xcode, package caches, test browsers, AI models, node_modules and build output, git worktrees, Trash and Downloads. Returns ranked findings, each with a plain-English explanation, a risk level (safe/review/danger) and the actions available. Present the findings to the user and let them choose. Never apply an action without the user agreeing to that specific item.',
      inputSchema: {
        ...scanShape,
        only: z.array(z.string()).optional().describe('Restrict to detectors: docker, android, xcode, pkgcaches, browsers, models, projects, worktrees, system, biggest.'),
        deep: z.boolean().optional().describe('Also sweep the whole home folder for unknown hogs. Slow (minutes).'),
        limit: z.number().optional().describe('Return only the N largest findings. Default 25.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const opts = await buildOptions({
        roots: a.roots,
        minBytes: a.min_size_mb !== undefined ? a.min_size_mb * 1024 * 1024 : undefined,
        staleDays: a.stale_days,
        deep: a.deep,
        only: a.only,
      });
      const result = await scan(opts);
      const limit = a.limit ?? 25;
      const shown = { ...result, findings: result.findings.slice(0, limit) };
      const free = result.disk ? `${fmtBytes(result.disk.freeBytes)} free of ${fmtBytes(result.disk.totalBytes)}. ` : '';
      return text(
        `${free}Found ${fmtBytes(result.totals.bytes)} in ${result.totals.findings} items; ${fmtBytes(result.totals.reclaimableBytes)} reclaimable with actions the tool can run. Showing ${shown.findings.length}.`,
        shown,
      );
    },
  );

  server.registerTool(
    'worktree_audit',
    {
      title: 'Audit git worktrees across all repos',
      description:
        'Read-only. Finds every git repo under the workspace roots and every linked worktree (including ones created by Claude Code, Codex, Cursor and Conductor), and classifies each as active, stale, dangling, locked, or at-risk (uncommitted or unpushed work). Also finds orphaned worktree folders whose repo no longer knows them. Use this to answer "how many worktrees do I have and which are leftovers?".',
      inputSchema: scanShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const opts = await buildOptions({
        roots: a.roots,
        minBytes: a.min_size_mb !== undefined ? a.min_size_mb * 1024 * 1024 : undefined,
        staleDays: a.stale_days,
      });
      const audit = await auditWorktrees(opts);
      const t = audit.totals;
      return text(
        `${t.repos} repos, ${t.linkedWorktrees} linked worktrees in ${t.reposWithLinkedWorktrees} repos (${t.byStatus.stale} stale, ${t.byStatus['at-risk']} at risk, ${t.byStatus.prunable} dangling, ${t.orphans} orphaned folders), ${fmtBytes(t.bytes)} total.`,
        { audit, findings: auditToFindings(audit, opts) },
      );
    },
  );

  server.registerTool(
    'explain_finding',
    {
      title: 'Explain one finding and its actions',
      description: 'Re-checks a single finding by id (from disk_scan) and returns its current size, explanation, risks and actions. Read-only.',
      inputSchema: { finding_id: z.string().describe('e.g. "docker:images" or "android:image:android-34/android-tv/arm64-v8a"'), ...scanShape },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a) => {
      const detector = a.finding_id.split(':')[0];
      const opts = await buildOptions({ roots: a.roots, only: [detector], minBytes: 0 });
      const result = await scan(opts);
      const f = result.findings.find((x) => x.id === a.finding_id);
      return f ? text(`${f.title}: ${fmtBytes(f.bytes)}, risk ${f.risk}.`, f) : text(`No finding "${a.finding_id}" right now. It may already be gone.`, null);
    },
  );

  server.registerTool(
    'apply_action',
    {
      title: 'Apply one cleanup action',
      description:
        'Runs ONE allowlisted action from a finding. Dry run by default: it returns the exact command and warning without changing anything. Only set confirm=true after the user has explicitly agreed to this specific action, and read the action\'s warning to them first. Actions with risk "danger" and manual actions are always refused. State is re-checked before running, so a stale id fails safely.',
      inputSchema: {
        action_id: z.string().describe('The action id from a finding, e.g. "docker:build-cache#prune".'),
        confirm: z.boolean().optional().describe('true = actually run it. Omit for a dry run.'),
        roots: scanShape.roots,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (a) => {
      const opts = await buildOptions({ roots: a.roots });
      const res = await applyAction(opts, a.action_id, a.confirm === true);
      return text(res.message, res);
    },
  );

  await server.connect(new StdioServerTransport());
}

// Run directly as `dev-disk-doctor-mcp`.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startMcp().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

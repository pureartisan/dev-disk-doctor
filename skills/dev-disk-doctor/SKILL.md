---
name: dev-disk-doctor
description: Diagnose why a developer machine's disk is full and clean it up safely. Use when the user says their disk or Mac storage is full, "Documents" is huge, Docker/Android/Xcode/node_modules are eating space, or they want to find leftover git worktrees from Claude Code, Codex or Cursor.
---

# dev-disk-doctor playbook

Goal: find what is using disk space, explain it in plain words, and let the user choose what to clean. Never delete anything the user has not agreed to, item by item.

## 1. Scan (read-only)

Prefer the MCP tools if the `dev-disk-doctor` server is connected: `disk_scan`, `worktree_audit`, `explain_finding`, `apply_action`.

Otherwise use the CLI:

```bash
npx -y dev-disk-doctor@latest scan --json          # takes about a minute
npx -y dev-disk-doctor@latest worktrees --json     # git worktree audit
npx -y dev-disk-doctor@latest scan --deep --json   # also sweeps the whole home folder (slow, ask first)
```

Add `--root <dir>` if the user keeps projects somewhere unusual. To make it stick, run `dev-disk-doctor roots add <dir>` (saved in `~/.dev-disk-doctor/config`, ask the user first since it writes a file).

## 2. Present options

Summarise: free space, total found, and how much is reclaimable. Then list the biggest items grouped by risk:

- **SAFE**: regenerates automatically (caches, build output). Offer these first.
- **REVIEW**: probably fine but check (old Docker images, AI models, stale worktrees, active-project build folders). Say what is lost and how to get it back.
- **CAREFUL** (`danger`): could lose data (Docker volumes, dirty worktrees, backups, emulator images in use). Explain; the tool will not run these.

For each item say: what it is, how big, what deleting it costs, and the exact command. Lead with the biggest wins. Do not read out the whole list.

## 3. Apply only with explicit consent

For each item the user approves:

1. Dry run first: `apply_action` without `confirm`, or `npx -y dev-disk-doctor@latest fix "<action id>"`.
2. Read the action's warning to the user (for example "quit Chrome first", "images that only exist locally are lost").
3. Run for real only after they say yes to that item: `confirm: true`, or `--yes`.

One approval covers one action, not a batch and not later items. The CLI also has `fix safe [--yes]`, which runs every SAFE item at once; only use it when the user has asked for exactly that, after showing them the dry run.

## Rules

- Never `rm -rf` anything yourself that the tool did not offer.
- Never remove a worktree that is `at-risk` (uncommitted changes or unpushed commits). Show the user `git status` and the unpushed log, and let them decide.
- For orphaned worktree folders, ask the user to look inside first: git can no longer say whether they hold unsaved work.
- Docker's `Docker.raw` never shrinks after pruning on its own. After pruning, tell the user to compact it in Docker Desktop → Settings → Resources.
- Android emulator images used by an AVD are flagged and must stay.
- After cleanup, run the scan again and report the free-space change.

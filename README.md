# dev-disk-doctor

**Why is my disk full?** A read-only disk and git-worktree doctor for developer machines. It finds the space hogs (Docker, Android emulators, Xcode, `node_modules`, package caches, AI models, orphaned git worktrees), explains each one, and gives you a ready-to-run fix with a warning when one is needed.

Works as a CLI and as an **MCP server**, so an AI agent (Claude Code, Cursor, Codex…) can run it, show you the options, and ask before touching anything.

```bash
npm install -g dev-disk-doctor
dev-disk-doctor              # scan, read-only
dev-disk-doctor worktrees    # how many git worktrees do I have, and which are leftovers?
```

## Install

You need [Node.js](https://nodejs.org) 18 or newer. Nothing else to install.

```bash
npm install -g dev-disk-doctor      # install the dev-disk-doctor command
dev-disk-doctor --version           # check it worked
```

- **Update:** `npm install -g dev-disk-doctor@latest`
- **Uninstall:** `npm uninstall -g dev-disk-doctor`
- **Try it without installing:** `npx dev-disk-doctor`. `npx` runs the tool from a temporary cache and leaves no `dev-disk-doctor` command behind, so use `npm install -g` if you want the plain command.
- If the shell says `dev-disk-doctor: command not found` after installing, the folder npm puts global commands in is not on your `PATH`. `npm config get prefix` shows it; add `<prefix>/bin` to `PATH`.

The examples below use the installed `dev-disk-doctor` command. Put `npx` in front of them if you did not install it.

## Getting started

1. **Scan** (read-only, about a minute on a big disk):
   ```bash
   dev-disk-doctor
   ```
   The first time, it asks where your projects live (see [Where it looks](#where-it-looks-for-your-projects)). You then get a ranked list. Each item says what it is, how big it is, how risky deleting it is, and, when the tool can run the fix, a ready-to-paste `run:` line.
2. **Check the git worktrees** (also read-only):
   ```bash
   dev-disk-doctor worktrees
   ```
3. **Fix one item at a time.** Copy the `run:` line from the scan. It shows what would happen and changes nothing:
   ```bash
   dev-disk-doctor fix "docker:build-cache#prune"
   ```
   Add `--yes` to actually run it.
4. **Or clean every SAFE item in one go.** Preview first, then add `--yes`:
   ```bash
   dev-disk-doctor fix safe
   dev-disk-doctor fix safe --yes
   ```
   It lists the warnings to read first (such as "quit Chrome"), runs the biggest items first, and carries on if one fails. `REVIEW` items are never batched: pick those one at a time with their `run:` line.
5. **Or let an AI agent drive it**; see [Use it with an AI agent](#use-it-with-an-ai-agent-mcp) below.

## Commands

| Command | What it does |
|---|---|
| `dev-disk-doctor` (or `dev-disk-doctor scan`) | Scan for space hogs. Read-only. |
| `dev-disk-doctor worktrees` | Audit git worktrees across all your repos. Read-only. |
| `dev-disk-doctor fix <action-id>` | Show what one action would do. Add `--yes` to run it. |
| `dev-disk-doctor fix safe` | The same for every SAFE item at once. Add `--yes` to run them. |
| `dev-disk-doctor roots` | Show which workspace folders will be searched. |
| `dev-disk-doctor roots add <dir>` | Remember a workspace folder for next time. |
| `dev-disk-doctor roots remove <dir>` | Forget a saved workspace folder. |
| `dev-disk-doctor roots auto` | Always figure the folders out, and stop asking. |
| `dev-disk-doctor roots reset` | Forget every saved choice and ask again next time. |
| `dev-disk-doctor mcp` | Start the MCP server on stdio, for AI agents. |
| `dev-disk-doctor --help` (or `-h`, `help`) | List every command and option in the terminal. |
| `dev-disk-doctor --version` | Print the version. |

Options (they go after the command):

| Option | What it does |
|---|---|
| `--json` | Machine-readable output with a stable schema. |
| `--root <dir>` | Workspace folder to search. Repeatable. Replaces the defaults for this run. |
| `--min-size <MB>` | Ignore items smaller than this. Default 100. |
| `--stale-days <n>` | Days idle before a project or worktree counts as stale. Default 30. |
| `--only <detector>` | Run one detector: `docker`, `android`, `xcode`, `pkgcaches`, `browsers`, `models`, `projects`, `worktrees`, `system` or `biggest`. Repeatable. |
| `--deep` | Also sweep your whole home folder for unknown space hogs. Slow. |
| `--all` | Show every finding instead of the top 25. |
| `--yes` | With `fix`: actually run the action. Without it, `fix` is a dry run. |
| `--no-color` | Plain output. |

Examples:

```bash
dev-disk-doctor --only docker --only xcode      # just those two areas
dev-disk-doctor --min-size 500 --all            # everything over 500 MB
dev-disk-doctor worktrees --stale-days 14       # worktrees idle for two weeks
dev-disk-doctor --json > scan.json              # for scripts and agents
```

Nothing is deleted unless you run `fix <id> --yes` or `fix safe --yes`. Actions marked CAREFUL are never run by the tool.

## Where it looks for your projects

Projects, `node_modules` and git worktrees are searched in your *workspace folders*. You don't have to configure them:

- Common names directly under your home folder are always used if they exist: `dev`, `code`, `src`, `projects`, `work`, `workspace`, `workspaces`, `Developer`, `repos`, `git`, `Sites`.
- **Any other visible folder directly under your home that contains a git repo or project** within three levels is picked up too. So a company folder such as `~/acme` is found automatically, even though it has an arbitrary name.
- Also checked automatically, for worktrees: the places AI coding tools park them (`~/.codex/worktrees`, `~/.cursor/worktrees`, `~/.claude/worktrees`, `~/conductor`), and `.claude/worktrees` inside any repo.
- Never searched by default: `~/Documents`, `~/Desktop`, `~/Downloads`, `~/Library`, `~/Applications`, hidden folders, and cloud-sync folders (Dropbox, OneDrive, Google Drive, iCloud…), because they are slow and can trigger permission prompts.

See what it will use:

```bash
dev-disk-doctor roots
```

The first time you run a scan in a terminal, it asks where to look: figure it out (and remember that), type your folders (and remember them), type folders for this run only, or skip. It never asks when you pass `--root` or `--json`, when output is piped, in the MCP server, or once a choice is saved. `roots reset` makes it ask again.

Override it when your code lives somewhere else (for example `~/Documents/GitHub` or an external drive):

```bash
dev-disk-doctor --root ~/Documents/GitHub --root /Volumes/Work/code   # this run only
dev-disk-doctor roots add ~/Documents/GitHub                          # remember it for every run
dev-disk-doctor roots remove ~/Documents/GitHub                       # forget it again
dev-disk-doctor roots auto                                            # always figure it out, don't ask
dev-disk-doctor roots reset                                           # forget every saved choice
```

Saved choices live in `~/.dev-disk-doctor/config`, a small JSON file (`{ "roots": ["/Users/you/Documents/GitHub"] }`, plus `"autoDiscover": true` if you chose "figure it out") you can also edit by hand. The CLI and the MCP server both read it. Folders that no longer exist are skipped but stay in the file. Your home folder itself and `/` cannot be saved.

You can also set `DEV_DISK_DOCTOR_ROOTS="$HOME/Documents/GitHub:/Volumes/Work/code"` in your shell profile.

The first one that applies wins, and it turns auto-discovery off so only those folders are searched:

1. `--root` (or the `roots` argument of the MCP tools)
2. `DEV_DISK_DOCTOR_ROOTS`
3. folders saved with `roots add`
4. auto-discovery

## What it checks

| Area | Examples |
|---|---|
| Containers | Docker Desktop disk image (`Docker.raw`), unused images, build cache, stopped containers, volumes |
| Mobile | Android emulator system images (never one an AVD uses), AVD data, NDKs, Xcode DerivedData, DeviceSupport, simulators |
| Package caches | npm, pnpm (old store versions too), Yarn, Bun, pip, uv, conda, Homebrew, Cargo, Gradle, Maven, CocoaPods, Go |
| Test browsers | Playwright, Puppeteer, Cypress downloads |
| AI models | Hugging Face, Ollama, LM Studio, PyTorch hub, DiffusionBee |
| Projects | `node_modules`, `.next`, Rust `target/`, `Pods/`, Python venvs in your workspaces, with how long the project has been idle |
| **Git worktrees** | Every linked worktree in every repo under your workspaces, including those made by Claude Code, Codex, Cursor and Conductor: active, stale, dangling, locked, at-risk, or orphaned |
| System | Trash, big Downloads, logs, iOS backups, Time Machine local snapshots |
| Everything else | `--deep` sweeps your home folder for hogs nobody else recognises |

## Safe by design

- **Scanning never changes anything.** No network, no telemetry.
- Every finding has a risk level: `SAFE` (regenerates on its own), `REVIEW` (probably fine, check first) or `CAREFUL` (could lose data, never run by the tool).
- `fix <action-id>` is a **dry run** unless you add `--yes`. Actions come from a fixed allowlist built by the scanners; the tool never executes free-form commands.
- Worktrees are offered for removal only when they are clean, unlocked, and merged or fully pushed. Dirty worktrees, unpushed commits and Docker volumes are reported with a warning and no apply path.
- It will not delete anything outside your home folder, your home folder itself, or `Documents`, `Desktop`, `Library` and other top-level folders.

## Use it with an AI agent (MCP)

Add to your MCP client config:

```json
{
  "mcpServers": {
    "dev-disk-doctor": { "command": "npx", "args": ["-y", "dev-disk-doctor", "mcp"] }
  }
}
```

Claude Code: `claude mcp add dev-disk-doctor -- npx -y dev-disk-doctor mcp`

If you installed it globally you can point the client at the installed command instead: `"command": "dev-disk-doctor", "args": ["mcp"]`.

| Tool | What it does |
|---|---|
| `disk_scan` | Ranked findings with explanations, risk and available actions |
| `worktree_audit` | All repos, all worktrees, which are stale, dangling, orphaned or at risk |
| `explain_finding` | Re-checks one finding |
| `apply_action` | Runs one allowlisted action. Dry run unless `confirm: true`. Refuses anything risky |

No MCP? Give your agent the playbook in [`skills/dev-disk-doctor/SKILL.md`](skills/dev-disk-doctor/SKILL.md) and it can drive the CLI with `--json`.

## Why does macOS say "Documents" is 230 GB?

macOS Storage settings has a category called **Documents** that is not your `~/Documents` folder. It is everything macOS cannot file under Apps, Photos, Mail or System, which for a developer means `~/Library` (Docker's disk image, Android SDK images, app data), `~/.cache`, `~/.npm`, model downloads and your code. Run `dev-disk-doctor` to see what is actually in there.

## Common questions

- **How do I shrink `Docker.raw`?** Prune inside Docker (`docker image prune -a`, `docker builder prune -a`), then compact the disk image in Docker Desktop → Settings → Resources. The tool reports what is reclaimable and warns about volumes.
- **How do I delete old Android system images?** The scan lists every image under `~/Library/Android/sdk/system-images`, marks the ones your emulators use, and gives a removal command for the rest.
- **How do I find stale git worktrees?** `dev-disk-doctor worktrees` lists every linked worktree across your repos with its state and size. AI coding tools create many; some get orphaned.
- **Is the pnpm store safe to delete?** It is a cache. Old store versions (`v3`, `v10`) that your installed pnpm does not use can go; the active one is pruned rather than deleted.

## Platform support

macOS is the primary target and is tested. Linux works for the cross-platform checks (Docker, package caches, models, projects, worktrees). Windows is not supported yet.

## Development

```bash
npm install
npm test        # builds, then runs the node:test suite
npm run scan    # build and run against your machine
```

The scanner core is in `src/core`, one file per area in `src/detectors`, the worktree audit in `src/worktrees`, and the MCP server in `src/mcp.ts`. See [PLAN.md](PLAN.md) for the design.

## Releasing (maintainers)

Pushing a `v*` tag stages the release on npm through GitHub Actions, and a maintainer approves it with 2FA. Setup, the release steps, how to verify a release and troubleshooting are in [docs/RELEASING.md](docs/RELEASING.md).

## License

MIT

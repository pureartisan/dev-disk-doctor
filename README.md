# dev-disk-doctor

**Why is my disk full?** A read-only disk and git-worktree doctor for developer machines. It finds the space hogs (Docker, Android emulators, Xcode, `node_modules`, package caches, AI models, orphaned git worktrees), explains each one, and gives you a ready-to-run fix with a warning when one is needed.

Works as a CLI and as an **MCP server**, so an AI agent (Claude Code, Cursor, Codex…) can run it, show you the options, and ask before touching anything.

```bash
npx dev-disk-doctor            # scan, read-only
npx dev-disk-doctor worktrees  # how many git worktrees do I have, and which are leftovers?
```

## Getting started

You need [Node.js](https://nodejs.org) 18 or newer. Nothing else to install.

1. **Scan** (read-only, about a minute on a big disk):
   ```bash
   npx dev-disk-doctor
   ```
   You get a ranked list. Each item says what it is, how big it is, how risky deleting it is, and the exact command to fix it.
2. **Check the git worktrees** (also read-only):
   ```bash
   npx dev-disk-doctor worktrees
   ```
3. **Fix one item at a time.** Copy the `id:` shown under an action. This shows what would happen and changes nothing:
   ```bash
   npx dev-disk-doctor fix "docker:build-cache#prune"
   ```
   Add `--yes` to actually run it.
4. **Or let an AI agent drive it**; see [Use it with an AI agent](#use-it-with-an-ai-agent-mcp) below.

To install it globally instead of using `npx`: `npm install -g dev-disk-doctor`, then run `dev-disk-doctor`.

## Where it looks for your projects

Projects, `node_modules` and git worktrees are searched in your *workspace folders*. You don't have to configure them:

- Common names directly under your home folder are always used if they exist: `dev`, `code`, `src`, `projects`, `work`, `workspace`, `workspaces`, `Developer`, `repos`, `git`, `Sites`.
- **Any other visible folder directly under your home that contains a git repo or project** within three levels is picked up too. So a company folder such as `~/acme` is found automatically, even though it has an arbitrary name.
- Also checked automatically, for worktrees: the places AI coding tools park them (`~/.codex/worktrees`, `~/.cursor/worktrees`, `~/.claude/worktrees`, `~/conductor`), and `.claude/worktrees` inside any repo.
- Never searched by default: `~/Documents`, `~/Desktop`, `~/Downloads`, `~/Library`, `~/Applications`, hidden folders, and cloud-sync folders (Dropbox, OneDrive, Google Drive, iCloud…), because they are slow and can trigger permission prompts.

See what it will use:

```bash
npx dev-disk-doctor roots
```

Override it when your code lives somewhere else (for example `~/Documents/GitHub` or an external drive):

```bash
npx dev-disk-doctor --root ~/Documents/GitHub --root /Volumes/Work/code
# or, for every run:
export DEV_DISK_DOCTOR_ROOTS="$HOME/Documents/GitHub:/Volumes/Work/code"
```

When you pass `--root` or set `DEV_DISK_DOCTOR_ROOTS`, auto-discovery is turned off and only those folders are searched.

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

| Tool | What it does |
|---|---|
| `disk_scan` | Ranked findings with explanations, risk and available actions |
| `worktree_audit` | All repos, all worktrees, which are stale, dangling, orphaned or at risk |
| `explain_finding` | Re-checks one finding |
| `apply_action` | Runs one allowlisted action. Dry run unless `confirm: true`. Refuses anything risky |

No MCP? Give your agent the playbook in [`skills/dev-disk-doctor/SKILL.md`](skills/dev-disk-doctor/SKILL.md) and it can drive the CLI with `--json`.

## CLI

```text
dev-disk-doctor [scan]            Scan for space hogs (read-only)
dev-disk-doctor worktrees         Audit git worktrees across all your repos
dev-disk-doctor fix <action-id>   Show what an action does; add --yes to run it
dev-disk-doctor roots             Show which workspace folders will be searched
dev-disk-doctor mcp               Start the MCP server on stdio

--json  --root <dir>  --min-size <MB>  --stale-days <n>  --only <detector>  --deep  --all  --yes
```

## Why does macOS say "Documents" is 230 GB?

macOS Storage settings has a category called **Documents** that is not your `~/Documents` folder. It is everything macOS cannot file under Apps, Photos, Mail or System, which for a developer means `~/Library` (Docker's disk image, Android SDK images, app data), `~/.cache`, `~/.npm`, model downloads and your code. Run `npx dev-disk-doctor` to see what is actually in there.

## Common questions

- **How do I shrink `Docker.raw`?** Prune inside Docker (`docker image prune -a`, `docker builder prune -a`), then compact the disk image in Docker Desktop → Settings → Resources. The tool reports what is reclaimable and warns about volumes.
- **How do I delete old Android system images?** The scan lists every image under `~/Library/Android/sdk/system-images`, marks the ones your emulators use, and gives a removal command for the rest.
- **How do I find stale git worktrees?** `npx dev-disk-doctor worktrees` lists every linked worktree across your repos with its state and size. AI coding tools create many; some get orphaned.
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

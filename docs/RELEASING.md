# Releasing dev-disk-doctor

How to publish a new version to npm, and how to check it worked. Pushing a version tag (`v*`) runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which builds, tests and **stages** the package on npm and creates a GitHub release. The version does not go live until a maintainer approves it with 2FA.

There is no npm token to create or rotate. The workflow authenticates to npm through GitHub OIDC as a *trusted publisher*.

## One-time setup

Already done for this repo. Redo it only if the trusted publisher is deleted or expires.

1. On [npmjs.com](https://www.npmjs.com), open the `dev-disk-doctor` package → **Settings** → **Trusted Publisher** → **GitHub Actions**.
2. Fill in:

   | Field | Value |
   |---|---|
   | Organization or user | `pureartisan` |
   | Repository | `dev-disk-doctor` |
   | Workflow filename | `release.yml` (exact, including the extension) |
   | Environment name | leave blank (the workflow does not use a GitHub environment) |
   | Allow `npm publish` | **unticked**. Staging is always allowed; direct publishing is not. |
   | Allow `npm dist-tag` | unticked |

3. Save. npm does not check the configuration when you save it. A mistake only shows up when a release runs, as `ENEEDAUTH`.

A new trusted publisher that has not completed a successful publish within **2 days** expires and has to be deleted and created again.

Requirements the workflow already meets: Node 22.14 or newer, npm 11.15.0 or newer (the workflow updates npm), `permissions: id-token: write`, a GitHub-hosted runner, a public repo, and a `repository.url` in `package.json` that matches this repo.

## Releasing a version

Changes reach `main` through PRs, so the version bump goes through one too, and the tag is pushed after it merges.

1. Branch from an up-to-date `main` and bump the version without tagging:

   ```bash
   git checkout main && git pull
   git checkout -b release/X.Y.Z
   npm version patch --no-git-tag-version      # or minor / major
   ```

   | Change | Command |
   |---|---|
   | Bug fix, new detector, wording | `npm version patch` |
   | New command or option, new MCP tool | `npm version minor` |
   | Breaking change to CLI flags, JSON output schema or MCP tool names | `npm version major` |

2. Commit, push and open a PR. Merge it.
3. Tag the merged commit on `main` and push the tag:

   ```bash
   git checkout main && git pull
   npm test                       # same check the workflow runs
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

4. Watch the run, then approve the staged version (next section).

   ```bash
   gh run list -R pureartisan/dev-disk-doctor --workflow Release --limit 3
   gh run watch -R pureartisan/dev-disk-doctor
   ```

Version numbers on npm can never be reused. If a published version is bad, ship a fixed one and run `npm deprecate dev-disk-doctor@<bad> "use <fixed>"`.

## Dependency updates and automatic releases

[`.github/dependabot.yml`](../.github/dependabot.yml) opens a weekly PR for npm dependencies and one for GitHub Actions. Minor and patch bumps are grouped, and runtime dependencies are kept apart from dev dependencies.

The `automerge-dependabot` job in [`ci.yml`](../.github/workflows/ci.yml) squash-merges a Dependabot PR once every test job has passed, unless it contains a **major** bump. Major bumps stay open for a person to review.

### Daily auto release (schedule off by default)

Merging a dependency update does not release anything by itself. [`auto-release.yml`](../.github/workflows/auto-release.yml) runs once a day (07:00 UTC) and cuts **one** patch release if Dependabot updates to **runtime** dependencies (`dependencies` in `package.json`) were merged since the last release tag. A day of updates is therefore one version, not one per merge. It finds them by their `chore(deps):` commit titles, which `dependabot.yml` sets. Dev dependency (`chore(deps-dev):`), GitHub Actions (`ci:`) and major updates never trigger it.

The daily schedule is off until you turn it on:

```bash
gh variable set AUTO_RELEASE --body true -R pureartisan/dev-disk-doctor
gh variable delete AUTO_RELEASE -R pureartisan/dev-disk-doctor     # off again
```

Run it by hand any time, whatever the variable says (Actions tab → **Auto release** → **Run workflow**, or the command below). It releases only if there are runtime dependency updates waiting; tick **force** (`-f force=true`) to release anyway when there is at least one new commit since the last tag.

```bash
gh workflow run auto-release.yml -R pureartisan/dev-disk-doctor
gh workflow run auto-release.yml -R pureartisan/dev-disk-doctor -f force=true
```

When it releases, it bumps the patch version, commits `chore: release X.Y.Z` to `main`, pushes the tag and starts `release.yml` on it. The run summary lists the updates that were found, or says why nothing was released.

This does not publish to the public registry on its own. `release.yml` still only **stages** the version on npm, and you approve it with 2FA as described below. Reject a staged version you do not want.

It pushes straight to `main`, which only works while `main` has no branch protection or ruleset that blocks the GitHub Actions bot. GitHub also pauses scheduled workflows after 60 days without repository activity; a manual run or any push re-enables them.

## What the workflow does

1. Checks out the tagged commit, updates npm to 11.x and runs `npm ci`.
2. Fails if the tag does not equal `v` + the `package.json` version.
3. Runs `npm test` (build plus the test suite).
4. Runs `npm stage publish --provenance --access public`. This uploads the package to npm's staging area. It is **not** public yet.
5. Creates a GitHub release with generated notes. This happens when the version is staged, before you approve it on npm.

## Approve the staged version

Approving needs 2FA and cannot run in CI.

- **Website:** open the package on npmjs.com → **Staged Packages** → review the version → **Approve**.
- **CLI:**

  ```bash
  npm stage list dev-disk-doctor
  npm stage view <stage-id>
  npm stage approve <stage-id>
  ```

To discard a staged version instead, use **Reject** on the website or `npm stage reject <stage-id>`. A rejected version number can be staged again.

Until a version is approved, `npm view dev-disk-doctor version` shows the previous one. A brand new package first appears as a `0.0.0-stage` placeholder.

## Verify a release

Run these from a different folder than the repo, so you test the published package and not your local build.

```bash
cd "$(mktemp -d)"

# 1. The version is on npm and is the one you expect
npm view dev-disk-doctor version
npm view dev-disk-doctor dist.tarball

# 2. It runs from a clean machine state (bypasses any local cache)
npx --yes dev-disk-doctor@latest --version
npx --yes dev-disk-doctor@latest roots
npx --yes dev-disk-doctor@latest worktrees --json | head

# 3. The MCP server starts and lists its tools
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"check","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | npx --yes dev-disk-doctor@latest mcp | grep -o '"name":"[a-z_]*"'
```

Expected from the last command: `disk_scan`, `worktree_audit`, `explain_finding`, `apply_action`.

Also check by eye:

- The package page at `https://www.npmjs.com/package/dev-disk-doctor` shows the new version and a **Provenance** badge.
- The GitHub **Releases** page has a release for the tag.
- The README renders correctly on the npm page.

### Dry run before tagging

See exactly what would be published without publishing anything:

```bash
npm pack --dry-run
```

The tarball should contain `dist/src`, `skills/`, `README.md` and `LICENSE`, and nothing else (no `test/`, no `node_modules`).

## Publishing by hand

Only if CI is unavailable. Log in with `npm login`, start from a clean, up-to-date `main`, then run `npm publish --access public`. This skips provenance and the staging approval, and it needs an account that can publish directly.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Workflow did not start | The tag must start with `v` and be pushed (`git push origin vX.Y.Z`). The workflow file must already be on `main`. |
| "Tag … does not match package.json version" | Tag and `package.json` disagree. If nothing was published, delete the tag and redo it (below). |
| `ENEEDAUTH` or `401` / `403` on stage | The trusted publisher is missing, expired (2 days with no successful publish), or does not match. Check owner, repo, workflow filename `release.yml`, an empty environment name, and that `repository.url` in `package.json` is this repo. |
| `403 … cannot publish over the previously published versions` | That version already exists on npm. Bump the version and tag again. |
| `npm stage` is not a command | npm is older than 11.15.0. The workflow updates npm; check that step ran. |
| Provenance error | The repo must be public, the runner GitHub-hosted, and the workflow must keep `id-token: write`. |
| Run succeeded but `npm view` shows the old version | The version is staged and waiting for approval. See "Approve the staged version". |

Re-do a tag that **failed before staging** (safe because nothing reached npm):

```bash
git push origin :refs/tags/vX.Y.Z   # delete the remote tag
git tag -d vX.Y.Z                   # delete the local tag
# fix the problem, merge to main, then:
git tag vX.Y.Z && git push origin vX.Y.Z
```

Never do this for a version that already shows on npm. If the version was staged and you reject it, delete the GitHub release for that tag too (`gh release delete vX.Y.Z`).

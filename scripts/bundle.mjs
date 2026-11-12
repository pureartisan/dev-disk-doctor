#!/usr/bin/env node
// Builds release/dev-disk-doctor-X.Y.Z.tgz: the npm package with its runtime dependencies packed
// inside, so it installs on a machine that cannot reach the npm registry (or cannot find this
// package on it):  npm install -g ./dev-disk-doctor-X.Y.Z.tgz
//
// Run `npm run bundle` (it builds first). The working tree and package.json are left untouched:
// the package is assembled in a temporary folder from the compiled dist/src and the lockfile.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'release');

if (!existsSync(join(root, 'dist', 'src', 'cli.js'))) {
  console.error('dist/src/cli.js is missing. Run `npm run build` first (or use `npm run bundle`).');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const stage = mkdtempSync(join(tmpdir(), 'dev-disk-doctor-bundle-'));

try {
  cpSync(join(root, 'dist', 'src'), join(stage, 'dist', 'src'), { recursive: true });
  cpSync(join(root, 'skills'), join(stage, 'skills'), { recursive: true });
  for (const file of ['README.md', 'LICENSE', 'package-lock.json']) cpSync(join(root, file), join(stage, file));

  const bundled = { ...pkg, bundleDependencies: Object.keys(pkg.dependencies ?? {}) };
  writeFileSync(join(stage, 'package.json'), JSON.stringify(bundled, null, 2) + '\n');

  // Exactly the locked runtime dependencies; npm pack then copies them into the tarball.
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });

  mkdirSync(outDir, { recursive: true });
  const out = execFileSync('npm', ['pack', '--pack-destination', outDir], { cwd: stage, encoding: 'utf8' });
  const file = out.trim().split('\n').pop();
  console.log(`\nBundle written to ${join('release', file)}`);
  console.log(`Install it with: npm install -g ./release/${file}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

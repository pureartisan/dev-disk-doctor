import path from 'node:path';
import type { Category, Detector, Finding, Risk } from '../core/types.js';
import { execAction, manualAction, pathFinding, type PathFindingSpec } from './helpers.js';

/**
 * Known developer caches, as data. Each entry lists the places a tool may keep it (macOS and Linux
 * differ); every location that exists becomes its own finding with a delete action.
 *
 * Only add things the owning tool downloads or rebuilds on demand. Anything holding work, settings or
 * data that cannot be fetched again is `review` (look first) or `keep` (reported, never deleted).
 */
export interface CacheDef {
  key: string;
  title: string;
  category: Category;
  /** Places the cache can live. Absolute. Each one that exists is reported. */
  paths: string[];
  why: string;
  /** Default `safe`. Use `review` when deleting costs the user something (a long re-download, local state). */
  risk?: Risk;
  warning?: string;
  /** Run the tool's own cleaner instead of deleting the folder (needed when the folder is read-only). */
  clean?: { label: string; file: string; args: string[] };
  /** Data that is not a cache (VM disks and the like): reported with advice, never deleted by the tool. */
  keep?: { advice: string };
}

const REGEN = 'Downloaded on demand, so deleting it only costs a re-download the next time it is needed.';

export function knownCaches(h: string, platform: NodeJS.Platform): CacheDef[] {
  const mac = platform === 'darwin';
  const j = (...p: string[]) => path.join(h, ...p);
  /** Both usual homes of a tool's cache: ~/Library/Caches/<name> (macOS) and ~/.cache/<name> (Linux, and some Mac tools). */
  const cache = (...names: string[]) => [...names.map((n) => j('Library/Caches', n)), ...names.map((n) => j('.cache', n))];
  const appData = (name: string) => (mac ? j('Library/Application Support', name) : j('.config', name));

  const defs: CacheDef[] = [
    // ── JavaScript and frontend ──────────────────────────────────────────────
    { key: 'corepack', title: 'Corepack package managers', category: 'package-caches', paths: [j('.cache/node/corepack')], why: 'Yarn and pnpm versions that Corepack downloaded. Fetched again the next time a project asks for them.' },
    { key: 'node-gyp', title: 'node-gyp headers', category: 'package-caches', paths: cache('node-gyp'), why: 'Node headers downloaded to compile native add-ons. Fetched again on the next native build.' },
    { key: 'deno', title: 'Deno cache', category: 'package-caches', paths: cache('deno'), why: 'Downloaded and compiled Deno modules. Rebuilt on the next run.' },
    { key: 'electron', title: 'Electron downloads', category: 'package-caches', paths: cache('electron'), why: 'Electron binaries downloaded by electron and electron-forge installs.' },
    { key: 'electron-builder', title: 'electron-builder cache', category: 'package-caches', paths: cache('electron-builder'), why: 'Packaging tools and binaries electron-builder downloaded.' },
    { key: 'yarn-linux', title: 'Yarn cache', category: 'package-caches', paths: [j('.cache/yarn')], why: REGEN },
    { key: 'pnpm-linux', title: 'pnpm metadata cache', category: 'package-caches', paths: [j('.cache/pnpm')], why: REGEN },
    { key: 'typescript', title: 'TypeScript type acquisition cache', category: 'package-caches', paths: cache('typescript'), why: 'Type definitions your editor fetched for plain JavaScript projects. Fetched again when needed.' },
    { key: 'prisma', title: 'Prisma engines', category: 'package-caches', paths: [j('.cache/prisma')], why: 'Query engine binaries Prisma downloaded. Fetched again on the next generate.' },
    { key: 'selenium', title: 'Selenium Manager drivers', category: 'browsers', paths: [j('.cache/selenium')], why: 'Browser drivers and browsers Selenium Manager downloaded.' },
    { key: 'webdriver-manager', title: 'webdriver-manager drivers', category: 'browsers', paths: [j('.wdm')], why: 'Browser drivers downloaded by webdriver-manager.' },

    // ── Python ───────────────────────────────────────────────────────────────
    { key: 'poetry', title: 'Poetry cache', category: 'package-caches', paths: cache('pypoetry'), risk: 'review', why: 'Downloaded packages, plus the virtual environments Poetry made for your projects.', warning: 'Projects whose virtualenv lives here need `poetry install` again.' },
    { key: 'pipenv', title: 'Pipenv cache', category: 'package-caches', paths: cache('pipenv'), why: REGEN },
    { key: 'pdm', title: 'PDM cache', category: 'package-caches', paths: cache('pdm'), why: REGEN },
    { key: 'pre-commit', title: 'pre-commit hook environments', category: 'package-caches', paths: [j('.cache/pre-commit')], why: 'Cloned hook repos and their environments. Rebuilt the next time hooks run.' },
    { key: 'pyenv-cache', title: 'pyenv download cache', category: 'package-caches', paths: [j('.pyenv/cache')], why: 'Python source tarballs kept after building a version. Installed versions are not touched.' },
    { key: 'nvm-cache', title: 'nvm download cache', category: 'package-caches', paths: [j('.nvm/.cache')], why: 'Node tarballs kept after installing a version. Installed versions are not touched.' },

    // ── JVM, Go, Rust and native ─────────────────────────────────────────────
    { key: 'go-modcache', title: 'Go module cache', category: 'package-caches', paths: [j('go/pkg/mod')], why: 'Downloaded Go modules, shared by every project. Fetched again on the next build.', clean: { label: 'Run go clean -modcache', file: 'go', args: ['clean', '-modcache'] } },
    { key: 'sccache', title: 'sccache compile cache', category: 'package-caches', paths: [j('Library/Caches/Mozilla.sccache'), j('.cache/sccache')], why: 'Cached compiler output. Rebuilt as you compile.' },
    { key: 'ccache', title: 'ccache compile cache', category: 'package-caches', paths: [j('.ccache'), ...cache('ccache')], why: 'Cached compiler output. Rebuilt as you compile.' },
    { key: 'bazel', title: 'Bazel cache', category: 'package-caches', paths: [j('.cache/bazel')], why: 'Bazel output and downloaded dependencies. Rebuilt on the next build, which can take a long time.', warning: 'Run `bazel shutdown` first.' },
    { key: 'bazelisk', title: 'Bazelisk downloads', category: 'package-caches', paths: cache('bazelisk'), why: 'Bazel versions Bazelisk downloaded.' },
    { key: 'ivy', title: 'Ivy cache', category: 'package-caches', paths: [j('.ivy2/cache')], why: REGEN },
    { key: 'coursier', title: 'Coursier cache', category: 'package-caches', paths: cache('Coursier', 'coursier'), why: 'Scala and JVM artifacts Coursier downloaded.' },
    { key: 'sdkman-archives', title: 'SDKMAN downloads', category: 'package-caches', paths: [j('.sdkman/archives')], why: 'Zip files kept after installing JDKs and other SDKs. Installed candidates are not touched.' },
    { key: 'kotlin-native', title: 'Kotlin/Native toolchains (~/.konan)', category: 'package-caches', paths: [j('.konan')], risk: 'review', why: 'Kotlin/Native compiler and dependencies downloaded by Gradle.', warning: 'The next Kotlin Multiplatform build downloads several GB again.' },

    // ── .NET, PHP, Ruby, Elixir, Dart ────────────────────────────────────────
    { key: 'nuget', title: 'NuGet packages', category: 'package-caches', paths: [j('.nuget/packages')], why: 'Restored .NET packages. `dotnet restore` fetches them again.' },
    { key: 'composer', title: 'Composer cache', category: 'package-caches', paths: [...cache('composer'), j('.composer/cache')], why: REGEN },
    { key: 'bundler', title: 'Bundler cache', category: 'package-caches', paths: [j('.bundle/cache')], why: REGEN },
    { key: 'rvm-archives', title: 'RVM downloads', category: 'package-caches', paths: [j('.rvm/archives')], why: 'Ruby source archives kept after installing a version. Installed rubies are not touched.' },
    { key: 'hex', title: 'Hex package cache', category: 'package-caches', paths: [j('.hex/packages')], why: REGEN },
    { key: 'rebar3', title: 'rebar3 cache', category: 'package-caches', paths: [j('.cache/rebar3')], why: REGEN },
    { key: 'pub-cache', title: 'Dart and Flutter pub cache', category: 'package-caches', paths: [j('.pub-cache')], risk: 'review', why: 'Hosted packages for Dart and Flutter projects.', warning: 'Tools installed with `dart pub global activate` live here too and would need activating again.' },
    { key: 'cocoapods-specs', title: 'CocoaPods spec repos (~/.cocoapods)', category: 'mobile', paths: [j('.cocoapods')], why: 'The local copy of the CocoaPods spec index.', warning: 'The next `pod install` downloads the index again, which takes a while.' },

    // ── Mobile and Apple toolchains ──────────────────────────────────────────
    { key: 'xcode-cache', title: 'Xcode caches', category: 'mobile', paths: [j('Library/Caches/com.apple.dt.Xcode')], why: 'Xcode build and index caches. Rebuilt as you work.', warning: 'Quit Xcode first.' },
    { key: 'xcode-docs', title: 'Xcode documentation cache', category: 'mobile', paths: [j('Library/Developer/Xcode/DocumentationCache')], why: 'Downloaded documentation. Fetched again when you open it.' },
    { key: 'swiftpm', title: 'Swift Package Manager cache', category: 'mobile', paths: [j('Library/Caches/org.swift.swiftpm')], why: 'Cloned package repositories. Fetched again on the next resolve.' },
    { key: 'carthage', title: 'Carthage cache', category: 'mobile', paths: [j('Library/Caches/org.carthage.CarthageKit')], why: REGEN },
    { key: 'android-cache', title: 'Android tooling cache', category: 'mobile', paths: [j('.android/cache')], why: 'Downloaded SDK manager metadata and repository listings.' },
    { key: 'android-build-cache', title: 'Android build cache', category: 'mobile', paths: [j('.android/build-cache')], why: 'Cached Android Gradle outputs. Rebuilt on the next build.' },

    // ── AI and machine learning ──────────────────────────────────────────────
    { key: 'whisper', title: 'Whisper models', category: 'ai-models', paths: [j('.cache/whisper')], why: 'Speech models downloaded by Whisper. Fetched again on the next run.' },
    { key: 'llama-cpp', title: 'llama.cpp downloads', category: 'ai-models', paths: cache('llama.cpp'), why: 'Models downloaded by llama.cpp. Fetched again on the next run.' },
    { key: 'gpt4all', title: 'GPT4All models', category: 'ai-models', paths: [j('.cache/gpt4all')], why: 'Models downloaded by GPT4All bindings. Fetched again on the next run.' },
    { key: 'kagglehub', title: 'KaggleHub downloads', category: 'ai-models', paths: [j('.cache/kagglehub')], why: 'Datasets and models downloaded through kagglehub.' },
    { key: 'chroma-models', title: 'Chroma embedding models', category: 'ai-models', paths: [j('.cache/chroma')], why: 'The default embedding model ChromaDB downloaded.' },
    { key: 'keras', title: 'Keras datasets and models (~/.keras)', category: 'ai-models', paths: [j('.keras')], risk: 'review', why: 'Datasets and pretrained weights Keras downloaded.', warning: 'Also holds keras.json, which Keras recreates with defaults.' },
    { key: 'triton', title: 'Triton kernel cache', category: 'ai-models', paths: [j('.triton/cache')], why: 'Compiled GPU kernels. Recompiled on first use.' },
    { key: 'wandb', title: 'Weights & Biases cache', category: 'ai-models', paths: [j('.cache/wandb')], why: 'Artifacts and run data cached locally. Downloaded again when needed.' },
    { key: 'nltk', title: 'NLTK data (~/nltk_data)', category: 'ai-models', paths: [j('nltk_data')], risk: 'review', why: 'Corpora and models downloaded with nltk.download().', warning: 'Anything you added by hand is lost.' },

    // ── Infrastructure and DevOps ────────────────────────────────────────────
    { key: 'terraform-plugins', title: 'Terraform plugin cache', category: 'package-caches', paths: [j('.terraform.d/plugin-cache')], why: 'Provider binaries Terraform downloaded. Fetched again on the next init.' },
    { key: 'pulumi-plugins', title: 'Pulumi plugins', category: 'package-caches', paths: [j('.pulumi/plugins')], risk: 'review', why: 'Provider plugins Pulumi downloaded.', warning: 'Pulumi downloads the ones a stack needs again, but plugins you installed from a private source must be reinstalled.' },
    { key: 'helm', title: 'Helm cache', category: 'package-caches', paths: cache('helm'), why: 'Downloaded charts and repository indexes.' },
    { key: 'kube-cache', title: 'kubectl discovery cache', category: 'package-caches', paths: [j('.kube/cache')], why: 'Cached API discovery. Rebuilt on the next kubectl call.' },
    { key: 'mise', title: 'mise cache', category: 'package-caches', paths: cache('mise'), why: 'Downloaded tool archives and metadata. Installed tool versions are not touched.' },
    { key: 'asdf-downloads', title: 'asdf downloads', category: 'package-caches', paths: [j('.asdf/downloads')], why: 'Archives kept after installing a version. Installed versions are not touched.' },
    { key: 'vagrant-boxes', title: 'Vagrant boxes', category: 'containers', paths: [j('.vagrant.d/boxes')], risk: 'review', why: 'Downloaded base images for Vagrant machines.', warning: 'Boxes you built or changed locally cannot be downloaded again.' },

    // ── Editors and browsers ─────────────────────────────────────────────────
    ...(['Code', 'Cursor'] as const).flatMap((app): CacheDef[] => {
      const label = app === 'Code' ? 'VS Code' : app;
      const k = app.toLowerCase();
      return [
        { key: `${k}-cacheddata`, title: `${label} cached data`, category: 'package-caches', paths: [path.join(appData(app), 'CachedData')], why: 'Compiled code cache. Rebuilt when you restart the editor.', warning: `Quit ${label} first.` },
        { key: `${k}-cache`, title: `${label} cache`, category: 'package-caches', paths: [path.join(appData(app), 'Cache')], why: 'Web content cache. Rebuilt as you use the editor.', warning: `Quit ${label} first.` },
        { key: `${k}-vsix`, title: `${label} downloaded extension packages`, category: 'package-caches', paths: [path.join(appData(app), 'CachedExtensionVSIXs')], why: 'Extension packages kept after install. Installed extensions are not touched.' },
        { key: `${k}-logs`, title: `${label} logs`, category: 'package-caches', paths: [path.join(appData(app), 'logs')], why: 'Old log files from past sessions.' },
      ];
    }),
    { key: 'chrome-linux', title: 'Google Chrome cache', category: 'browsers', paths: [j('.cache/google-chrome')], why: 'Browser cache. Chrome refills it as you browse.', warning: 'Quit Chrome first.' },
    { key: 'firefox', title: 'Firefox cache', category: 'browsers', paths: [j('Library/Caches/Firefox'), j('.cache/mozilla')], why: 'Browser cache. Firefox refills it as you browse.', warning: 'Quit Firefox first.' },
    { key: 'edge', title: 'Microsoft Edge cache', category: 'browsers', paths: [j('Library/Caches/Microsoft Edge'), j('.cache/microsoft-edge')], why: 'Browser cache. Edge refills it as you browse.', warning: 'Quit Edge first.' },
    { key: 'brave', title: 'Brave cache', category: 'browsers', paths: [j('Library/Caches/BraveSoftware'), j('.cache/BraveSoftware')], why: 'Browser cache. Brave refills it as you browse.', warning: 'Quit Brave first.' },
    { key: 'arc', title: 'Arc cache', category: 'browsers', paths: [j('Library/Caches/company.thebrowser.Browser')], why: 'Browser cache. Arc refills it as you browse.', warning: 'Quit Arc first.' },

    // ── Virtual machines and container runtimes: data, not caches ────────────
    { key: 'colima', title: 'Colima VM (~/.colima)', category: 'containers', paths: [j('.colima')], risk: 'danger', why: 'The Colima virtual machine and its disk, which hold your images, containers and volumes.', keep: { advice: 'Prune inside the VM first (`docker system prune`), or `colima delete` to remove the VM and everything in it.' } },
    { key: 'lima', title: 'Lima VMs (~/.lima)', category: 'containers', paths: [j('.lima')], risk: 'danger', why: 'Lima virtual machines and their disks, with everything stored inside them.', keep: { advice: 'List them with `limactl list`; remove one with `limactl delete <name>` once you are sure nothing in it is needed.' } },
    { key: 'podman-machine', title: 'Podman machine disks', category: 'containers', paths: [j('.local/share/containers/podman/machine')], risk: 'danger', why: 'Podman VM disks, which hold your images, containers and volumes.', keep: { advice: 'Prune inside it first (`podman system prune`), or `podman machine rm` to remove the VM and everything in it.' } },
    { key: 'orbstack', title: 'OrbStack data (~/.orbstack)', category: 'containers', paths: [j('.orbstack')], risk: 'danger', why: 'OrbStack\'s virtual machine data, which holds your images, containers and volumes.', keep: { advice: 'Use OrbStack\'s own settings to prune or reset, and `docker system prune` to free space inside it.' } },
    { key: 'rancher-desktop', title: 'Rancher Desktop data', category: 'containers', paths: [j('Library/Application Support/rancher-desktop')], risk: 'danger', why: 'Rancher Desktop\'s virtual machine and its data, including images and volumes.', keep: { advice: 'Prune inside it first (`docker system prune`), or use Rancher Desktop → Troubleshooting → Reset.' } },
  ];

  return defs;
}

export const devcaches: Detector = {
  id: 'devcaches',
  title: 'More developer caches (frontend, backend, mobile, AI, infrastructure)',
  async run(opts) {
    const specs: PathFindingSpec[] = knownCaches(opts.home, opts.platform).flatMap((def) =>
      [...new Set(def.paths)].map((p, i): PathFindingSpec => {
        const risk: Risk = def.risk ?? 'safe';
        const base = {
          detector: 'devcaches',
          key: i === 0 ? def.key : `${def.key}@${i}`,
          category: def.category,
          title: `${def.title} (${p.replace(opts.home, '~')})`,
          path: p,
          risk,
          regenerable: !def.keep && risk !== 'danger',
          why: def.why,
          warning: def.warning,
        };
        if (def.keep) {
          return { ...base, actions: (id: string) => [manualAction(id, 'inspect', 'See what is inside', `du -sh ${JSON.stringify(p)}/* | sort -rh | head -20`, 'safe', def.keep!.advice)] };
        }
        if (def.clean) {
          const c = def.clean;
          return { ...base, actions: (id: string, bytes: number) => [execAction(id, 'clean', c.label, c.file, c.args, risk, { bytes, warning: def.warning })] };
        }
        return base;
      }),
    );
    // sizeOf limits how many `du` runs happen at once, so listing everything in parallel is safe.
    const found = await Promise.all(specs.map((spec) => pathFinding(spec, opts)));
    return found.filter((f): f is Finding => f !== undefined);
  },
};

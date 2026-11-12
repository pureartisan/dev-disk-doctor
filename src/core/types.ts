export type Risk = 'safe' | 'review' | 'danger';

export type Category =
  | 'containers'
  | 'mobile'
  | 'package-caches'
  | 'browsers'
  | 'ai-models'
  | 'projects'
  | 'worktrees'
  | 'system'
  | 'unknown';

/**
 * What an action does when applied. Only these three shapes exist so that nothing
 * outside the allowlist built by detectors can ever be executed.
 */
export type ActionKind =
  /** Run a program with fixed arguments (no shell). */
  | { type: 'exec'; file: string; args: string[]; cwd?: string }
  /** Delete one path. Must equal the owning finding's path. */
  | { type: 'remove-path'; path: string }
  /** Instructions only. The tool never applies these. */
  | { type: 'manual' };

export interface Action {
  /** Globally unique: `<findingId>#<name>`. */
  id: string;
  label: string;
  /** The command a human could paste into a terminal. */
  display: string;
  risk: Risk;
  kind: ActionKind;
  reclaimBytes?: number;
  warning?: string;
}

export interface Finding {
  /** `<detector>:<key>`, stable across runs. */
  id: string;
  detector: string;
  category: Category;
  title: string;
  path?: string;
  bytes: number;
  risk: Risk;
  /** True when the tool that owns the data rebuilds it on demand. */
  regenerable: boolean;
  /** One or two sentences: what this is and why it is big. */
  why: string;
  actions: Action[];
  meta?: Record<string, unknown>;
}

export interface ScanOptions {
  home: string;
  platform: NodeJS.Platform;
  /** Workspace roots searched for projects and git repos. */
  roots: string[];
  /** Ignore findings smaller than this. */
  minBytes: number;
  /** Days without activity before a project or worktree counts as stale. */
  staleDays: number;
  /** Also run the slow whole-home sweep for unknown space hogs. */
  deep: boolean;
  /** Restrict to these detector ids. */
  only?: string[];
  /** Per-detector time budget. */
  detectorTimeoutMs: number;
}

export interface Detector {
  id: string;
  title: string;
  /** Slow detectors only run with `deep`. */
  deepOnly?: boolean;
  /** Runs after the regular detectors, so `covered()` already holds their findings. */
  late?: boolean;
  /** `covered` returns findings from earlier detectors (used by the deep sweep). */
  run(opts: ScanOptions, covered: () => Finding[]): Promise<Finding[]>;
}

export interface DiskInfo {
  totalBytes: number;
  freeBytes: number;
}

export interface ScanResult {
  schema: 1;
  generatedAt: string;
  host: { platform: string; home: string };
  disk?: DiskInfo;
  options: { roots: string[]; minBytes: number; staleDays: number; deep: boolean };
  totals: {
    findings: number;
    /** Sum of every finding, overlaps removed (a node_modules inside a stale worktree counts once). */
    bytes: number;
    /** Bytes in findings that have at least one action the tool can apply and are not `danger`. */
    reclaimableBytes: number;
    bytesByRisk: Record<Risk, number>;
  };
  findings: Finding[];
  skipped: { detector: string; reason: string }[];
  timingsMs: Record<string, number>;
  /** Wall-clock time the whole scan took. Absent in scans saved before it was recorded. */
  durationMs?: number;
}

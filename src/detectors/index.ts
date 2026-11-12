import type { Detector } from '../core/types.js';
import { android } from './android.js';
import { biggest } from './biggest.js';
import { browsers, models } from './browsers-models.js';
import { custom } from './custom.js';
import { devcaches } from './devcaches.js';
import { discovery } from './discovery.js';
import { docker } from './docker.js';
import { pkgcaches } from './pkgcaches.js';
import { projects } from './projects.js';
import { system } from './system.js';
import { xcode } from './xcode.js';
import { worktrees } from '../worktrees/detector.js';

/** `custom`, `discovery` and `biggest` must stay last, in that order: each subtracts what the detectors before it already explain. */
export const detectors: Detector[] = [docker, android, xcode, pkgcaches, devcaches, browsers, models, projects, worktrees, system, custom, discovery, biggest];

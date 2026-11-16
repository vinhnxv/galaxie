// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export type { ComposeOptions, ComposeReport, Composition, ProjectFile } from './compose.js';
export { compose, LayerCollisionError, SelectionError } from './compose.js';
export { GuidanceError, loadGuidanceSource, renderGuidance } from './guidance.js';
export type { Layer, LayerManifest, WorkspaceFragment } from './layers.js';
export { LayerManifestError, loadLayers } from './layers.js';
export type { Fragment, JsonObject, JsonValue } from './merge.js';
export { MergeConflictError, mergeFragments } from './merge.js';
export type { PackageManager, Tarballs } from './packages.js';
export { knownPackages, resolveTarballs, TarballError } from './packages.js';
export {
  ProjectPathError,
  projectName,
  validateOutputPath,
  validateProjectName,
  validateTarget,
} from './paths.js';
export type { WritePlan } from './write.js';
export { ProjectWriteError, planWrite, writeProject } from './write.js';

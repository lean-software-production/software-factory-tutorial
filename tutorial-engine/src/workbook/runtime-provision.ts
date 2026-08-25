import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const SAFE_WORKSPACE_RELATIVE_PATH = Symbol("SafeWorkspaceRelativePath");

export type SafeWorkspaceRelativePath = string & { readonly [SAFE_WORKSPACE_RELATIVE_PATH]: true };

export interface RuntimeProvisionMountDeclaration {
  source: string;
  target: string;
  readonly: true;
}

export interface RuntimeProvisionProfile {
  mounts?: readonly RuntimeProvisionMountDeclaration[];
}

export interface TrustedRuntimeMount {
  hostSource: string;
  workspaceTarget: SafeWorkspaceRelativePath;
  readonly: true;
}

export interface TrustedRuntimeProvision {
  readonly mounts: readonly TrustedRuntimeMount[];
  readonly workspaceMountTargets: readonly SafeWorkspaceRelativePath[];
}

export type RuntimeProvisionInput = RuntimeProvisionProfile | TrustedRuntimeProvision;

export const NO_RUNTIME_PROVISION: TrustedRuntimeProvision = Object.freeze({
  mounts: Object.freeze([]) as readonly TrustedRuntimeMount[],
  workspaceMountTargets: Object.freeze([]) as readonly SafeWorkspaceRelativePath[],
});

function hasDrivePrefix(path: string): boolean { return /^[a-zA-Z]:[\\/]/.test(path); }

export function assertSafeWorkspaceMountTarget(target: string): SafeWorkspaceRelativePath {
  const normalized = target.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (!normalized || isAbsolute(target) || hasDrivePrefix(target) || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Refusing unsafe runtime mount target: ${target}`);
  }
  if (normalized === ".git" || normalized.startsWith(".git/")) throw new Error("Refusing to mount runtime provision into session Git metadata.");
  return normalized as SafeWorkspaceRelativePath;
}

function targetContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function validateNoTargetConflicts(targets: readonly SafeWorkspaceRelativePath[]): void {
  const ordered = [...targets].sort();
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (targetContains(previous, current)) {
      throw new Error(previous === current
        ? `Duplicate runtime mount target: ${current}`
        : `Conflicting runtime mount targets: ${previous} and ${current}`);
    }
  }
}

function canonicalRuntimeSource(source: string): string {
  if (!source || !isAbsolute(source)) throw new Error(`Runtime mount source must be an absolute host path: ${source}`);
  const real = realpathSync(resolve(source));
  const info = statSync(real);
  if (!info.isDirectory()) throw new Error(`Runtime mount source must be an existing directory: ${source}`);
  return real;
}

export function trustRuntimeProvision(profile: RuntimeProvisionInput = {}): TrustedRuntimeProvision {
  const isTrustedShape = "workspaceMountTargets" in profile;
  const declarations = profile.mounts ?? [];
  if (declarations.length === 0) return NO_RUNTIME_PROVISION;

  const mounts = declarations.map((mount): TrustedRuntimeMount => {
    if (!mount || typeof mount !== "object") throw new Error("Runtime provision mounts must be objects.");
    if (mount.readonly !== true) throw new Error("Runtime mounts must be read-only.");
    const source = isTrustedShape ? (mount as TrustedRuntimeMount).hostSource : (mount as RuntimeProvisionMountDeclaration).source;
    const target = isTrustedShape ? (mount as TrustedRuntimeMount).workspaceTarget : (mount as RuntimeProvisionMountDeclaration).target;
    return {
      hostSource: canonicalRuntimeSource(source),
      workspaceTarget: assertSafeWorkspaceMountTarget(target),
      readonly: true,
    };
  });

  validateNoTargetConflicts(mounts.map((mount) => mount.workspaceTarget));
  return Object.freeze({
    mounts: Object.freeze(mounts),
    workspaceMountTargets: Object.freeze(mounts.map((mount) => mount.workspaceTarget)),
  });
}


import "server-only";
import type { Bead, CreateInput, UpdateInput, DepType } from "./schema";
import { getProject, touchProject, DEMO_PROJECT, ConfigError, isManagedRegistryMode } from "./config";
import { createBdStore, isBdAvailable } from "./bd";
import { createBrStore, isBrAvailable } from "./br";
import { demoStore } from "./demo-store";
import type { ProjectEntry } from "./config";
import type { StoreKind, StorePolicy, StoreSource } from "./source";

/**
 * Storage abstraction. Two implementations:
 *  - BdStore  → shells out to the `bd` CLI (source of truth).
 *  - DemoStore → in-memory, seeded from the design export, so the app runs and
 *    is demoable even where bd isn't installed.
 */
export interface DoctorInfo {
  kind: StoreKind;
  ok: boolean;
  version?: string;
  repoPath: string;
  message: string;
  source?: StoreSource;
}

export interface BeadsStore {
  kind: StoreKind;
  source?: StoreSource;
  list(): Promise<Bead[]>;
  get(id: string): Promise<Bead | null>;
  create(input: CreateInput, actor: string): Promise<Bead>;
  update(id: string, patch: UpdateInput, actor: string): Promise<Bead>;
  /**
   * `reason` is only meaningful when closing — bd records it via
   * `bd close --reason`, and there is no way to attach one after the fact.
   */
  setStatus(id: string, status: string, actor: string, reason?: string): Promise<Bead>;
  remove(id: string, actor: string): Promise<void>;
  addComment(id: string, text: string, actor: string): Promise<Bead>;
  addDep(id: string, dependsOnId: string, type: DepType, actor: string): Promise<Bead>;
  removeDep(id: string, dependsOnId: string, actor: string): Promise<Bead>;
  /** Create a human approval gate that blocks `blocks` (`bd gate create --type human`). */
  createGate(blocks: string, reason: string | undefined, actor: string): Promise<Bead>;
  removeLabel(id: string, label: string, actor: string): Promise<Bead>;
  archive(id: string, actor: string): Promise<Bead>;
  doctor(): Promise<DoctorInfo>;
}

function managedPolicy(project: ProjectEntry): StorePolicy {
  if (project.path === null || !project.backend || !project.database || !project.sourceLabel || !project.sourceScope || !project.capabilities) {
    throw new ConfigError(`Managed project ${project.id} has incomplete source policy`, "registry_invalid");
  }
  if (project.backend === "bd" && !project.nativeProjectId) {
    throw new ConfigError(`Managed bd project ${project.id} must declare its native project id`, "registry_invalid");
  }
  return {
    managed: true,
    readOnly: project.readOnly === true,
    capabilities: project.capabilities,
    label: project.sourceLabel,
    scope: project.sourceScope,
    nativeProjectId: project.nativeProjectId,
    database: project.database,
    city: project.city,
    rig: project.rig,
  };
}

// One store per project id. Demo always maps to the shared in-memory store.
const stores = new Map<string, BeadsStore>();

export async function getStore(projectId: string): Promise<BeadsStore> {
  if (isManagedRegistryMode()) {
    const project = getProject(projectId);
    if (!project || project.path === null || project.id === DEMO_PROJECT.id) {
      throw new ConfigError(`Unknown project: ${projectId}`, "unknown_project");
    }
    const policy = managedPolicy(project);
    if (project.backend === "br") {
      if (!(await isBrAvailable(project.path, policy))) {
        throw new ConfigError(`br is not available for the managed project ${project.id}`, "br_unavailable");
      }
      const store = createBrStore(project.path, policy);
      stores.set(projectId, store);
      return store;
    }
    if (!(await isBdAvailable(project.path, policy))) {
      throw new ConfigError(`bd is not available for the managed project ${project.id}`, "bd_unavailable");
    }
    const store = createBdStore(project.path, policy);
    stores.set(projectId, store);
    return store;
  }
  if (projectId === DEMO_PROJECT.id) return demoStore;

  const cached = stores.get(projectId);
  if (cached) return cached;

  const project = getProject(projectId);
  if (!project || project.path === null) {
    throw new ConfigError(`Unknown project: ${projectId}`, "unknown_project");
  }
  if (!(await isBdAvailable(project.path))) {
    throw new ConfigError(
      `bd is not available for "${project.name}" (${project.path}). ` +
        `Check that bd is installed and the folder still contains a .beads directory.`,
      "bd_unavailable",
    );
  }
  const store = createBdStore(project.path);
  stores.set(projectId, store);
  // First resolution this session — record that the project was opened.
  touchProject(projectId);
  return store;
}

/** Reset cached store(s) — one project, or all when no id is given. */
export function resetStore(projectId?: string) {
  if (projectId) stores.delete(projectId);
  else stores.clear();
}

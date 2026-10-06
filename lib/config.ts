import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type { StoreCapabilities } from "./source";

/**
 * Local app config (NOT stored in beads). Lives as a small JSON file under the
 * OS config dir. Holds the human actor used to stamp writes, the human allowlist
 * for origin detection, the poll interval, and the registry of beads projects
 * the app knows about.
 *
 * Project identity is per-request (driven by the /p/<projectId> URL), so the
 * "active" project is NOT stored here — only the durable list of discovered ones.
 */
export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  /** ISO timestamps. */
  addedAt: string;
  lastOpened: string;
  /** Explicit native backend/source policy for the managed registry. */
  backend?: "bd" | "br";
  nativeProjectId?: string | null;
  database?: string;
  sourceLabel?: string;
  sourceScope?: string;
  readOnly?: boolean;
  capabilities?: StoreCapabilities;
  city?: string;
  rig?: string;
}

export interface AppConfig {
  humanActor: string;
  humanAllowlist: string[];
  pollIntervalMs: number;
  projects: ProjectEntry[];
  /**
   * Manual board ordering, kept app-local (NOT in beads): projectId → columnId →
   * ordered bead ids. Lets users drag beads within a column to set work order.
   */
  orders: Record<string, Record<string, string[]>>;
  /** Opt-in: show the gamification XP/level layer (off by default). */
  gamification: boolean;
}

/**
 * The built-in demo dataset, surfaced as an always-available pseudo-project.
 * It has no filesystem path; the store resolver maps it to the in-memory store.
 */
export const DEMO_PROJECT = {
  id: "demo",
  name: "Demo",
  path: null,
} as const;
export type DemoProject = typeof DEMO_PROJECT;

export class ConfigError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

/** A non-empty registry file selects the explicit multi-source mode. */
export function isManagedRegistryMode(): boolean {
  const managed = Boolean(process.env.SCOTTY_PROJECTS_FILE?.trim());
  if (!managed && process.env.SCOTTY_BR_REPO?.trim()) {
    throw new ConfigError(
      "SCOTTY_BR_REPO legacy mode is unsupported; configure an explicit managed registry with SCOTTY_PROJECTS_FILE",
      "unsupported_mode",
    );
  }
  return managed;
}

/** An operator may lock editing independently of the per-browser preference. */
export function isHardReadOnly(): boolean {
  return process.env.SCOTTY_HARD_READ_ONLY === "1" || process.env.SCOTTY_HARD_READ_ONLY === "true";
}

/**
 * SCOTTY_READ_ONLY=1 (or "true") supplies the default for new browser sessions.
 * The session cookie overrides that default when the user changes the mode.
 * In the effective read-only mode, project writes are refused server-side and
 * editing controls are disabled. App settings remain available.
 */
export const VIEWER_MODE_COOKIE = "scotty-viewer-mode";

export function isReadOnly(request?: Request): boolean {
  isManagedRegistryMode();
  if (isHardReadOnly()) return true;
  // This is a browser preference, not an authorization boundary. A session
  // cookie lets one browser override the launch default without affecting others.
  const cookie = request?.headers.get("cookie")?.split(";").map((v) => v.trim())
    .find((v) => v.startsWith(`${VIEWER_MODE_COOKIE}=`))?.slice(VIEWER_MODE_COOKIE.length + 1);
  if (cookie === "read-only") return true;
  if (cookie === "editing") return false;
  const v = process.env.SCOTTY_READ_ONLY;
  return v === "1" || v === "true";
}

/**
 * Exact browser origin required for managed project-data writes. There is no
 * default: a deployment that enables writes must declare its browser origin.
 */
export function configuredWriteOrigin(): string {
  const raw = process.env.SCOTTY_WRITE_ORIGIN?.trim();
  if (!raw) throw new ConfigError("SCOTTY_WRITE_ORIGIN is required for managed writes", "csrf_origin");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError("SCOTTY_WRITE_ORIGIN must be an absolute http(s) origin", "csrf_origin");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ConfigError("SCOTTY_WRITE_ORIGIN must contain only an http(s) origin", "csrf_origin");
  }
  return parsed.origin;
}

/**
 * Focus-view lane chips: SCOTTY_LANE_PREFIX names a label prefix (e.g. "ctx:")
 * whose values partition work into lanes/teams/areas. When set, the Focus view
 * offers one filter chip per lane label found on the visible beads. Unset →
 * no chips (the feature is invisible).
 */
export function lanePrefix(): string | null {
  return process.env.SCOTTY_LANE_PREFIX || null;
}

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "bead-me-up-scotty");
}
function configFile(): string {
  return path.join(configDir(), "config.json");
}

function defaults(): AppConfig {
  let user = "you";
  try {
    user = os.userInfo().username || user;
  } catch {
    /* ignore */
  }
  const humanActor = process.env.BEADS_ACTOR || user;
  return {
    humanActor,
    humanAllowlist: [humanActor],
    // Fallback refresh interval. The SSE change stream (see lib/beads-watch)
    // drives fast updates; this interval only backstops a dropped stream.
    pollIntervalMs: 30000,
    projects: [],
    orders: {},
    gamification: false,
  };
}

// ---- helpers -------------------------------------------------------------

function hasBeads(p: string): boolean {
  try {
    return fs.existsSync(path.join(p, ".beads"));
  } catch {
    return false;
  }
}
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function existingRealpath(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    throw new ConfigError(`Path does not exist: ${path.resolve(p)}`, "path_not_found");
  }
}

/** Resolve both sides before containment checks so symlinks cannot escape. */
export function canonicalPathWithinRoot(inputPath: string, rootPath: string): string {
  const root = existingRealpath(rootPath);
  const candidate = existingRealpath(inputPath);
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ConfigError(`Path is outside the allowed root: ${candidate}`, "path_outside_root");
  }
  return candidate;
}

/** Explicit filesystem browsing root; managed registry mode never exposes it. */
export function filesystemRoot(): string | null {
  if (isManagedRegistryMode()) return null;
  const configured = process.env.BEADS_FS_ROOT?.trim();
  return configured ? existingRealpath(configured) : null;
}

function sameDir(a: string, b: string): boolean {
  return realpathOrSelf(a) === realpathOrSelf(b);
}
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}
function makeId(absPath: string, taken: Set<string>): string {
  const base = slug(path.basename(absPath));
  let id = base;
  while (taken.has(id) || id === DEMO_PROJECT.id) {
    id = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return id;
}
function makeEntry(inputPath: string, taken: Set<string>): ProjectEntry {
  const abs = path.resolve(inputPath);
  const now = new Date().toISOString();
  return {
    id: makeId(abs, taken),
    name: path.basename(abs) || abs,
    path: abs,
    addedAt: now,
    lastOpened: now,
  };
}

const registryCapabilitiesSchema = z.object({
  comments: z.boolean(),
  priority: z.boolean(),
}).strict();

const registryEntrySchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  backend: z.enum(["bd", "br"]),
  path: z.string().min(1),
  nativeProjectId: z.string().min(1).nullable(),
  database: z.string().min(1),
  sourceLabel: z.string().min(1),
  sourceScope: z.string().min(1),
  readOnly: z.boolean(),
  capabilities: registryCapabilitiesSchema,
  city: z.string().min(1).optional(),
  rig: z.string().min(1).optional(),
}).strict();

const registrySchema = z.array(registryEntrySchema).min(1);

/**
 * Load the explicit managed registry once per process. Registry paths are
 * canonicalized and then required to remain exactly those canonical paths;
 * this prevents a symlink or a browser registration from changing authority.
 */
function loadManagedProjects(): ProjectEntry[] {
  const file = process.env.SCOTTY_PROJECTS_FILE?.trim();
  if (!file) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConfigError(`Could not read managed project registry: ${(error as Error).message}`, "registry_invalid");
  }
  const result = registrySchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`Managed project registry is invalid: ${result.error.issues.map((i) => i.message).join("; ")}`, "registry_invalid");
  }
  const now = new Date().toISOString();
  const seen = new Set<string>();
  return result.data.map((entry) => {
    if (seen.has(entry.id)) throw new ConfigError(`Duplicate managed project id: ${entry.id}`, "registry_invalid");
    seen.add(entry.id);
    const configured = path.resolve(entry.path);
    const canonical = existingRealpath(configured);
    if (canonical !== configured || !hasBeads(canonical)) {
      throw new ConfigError(`Managed project path is not a canonical Beads root: ${entry.path}`, "registry_path_not_allowed");
    }
    return {
      ...entry,
      path: canonical,
      addedAt: now,
      lastOpened: now,
    };
  });
}

/** Drop malformed registry entries so a bad config file never crashes startup. */
function sanitizeProjects(input: unknown): ProjectEntry[] {
  if (!Array.isArray(input)) return [];
  const out: ProjectEntry[] = [];
  const seen = new Set<string>();
  for (const it of input) {
    if (!it || typeof it !== "object") continue;
    const e = it as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.path !== "string") continue;
    if (e.id === DEMO_PROJECT.id || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      path: e.path,
      name: typeof e.name === "string" && e.name ? e.name : path.basename(e.path) || e.path,
      addedAt: typeof e.addedAt === "string" ? e.addedAt : new Date().toISOString(),
      lastOpened: typeof e.lastOpened === "string" ? e.lastOpened : new Date().toISOString(),
    });
  }
  return out;
}

// ---- load / persist ------------------------------------------------------

let cached: AppConfig | null = null;

/**
 * Persist the config, preserving any unknown keys already on disk (e.g. the
 * legacy `repoPath`/`demo` fields) so older app versions can still read them.
 */
function persist(cfg: AppConfig): void {
  cached = cfg;
  if (isManagedRegistryMode()) return;
  try {
    fs.mkdirSync(configDir(), { recursive: true });
    let base: Record<string, unknown> = {};
    try {
      base = JSON.parse(fs.readFileSync(configFile(), "utf8")) as Record<string, unknown>;
    } catch {
      base = {};
    }
    const next = { ...base, ...cfg };
    fs.writeFileSync(configFile(), JSON.stringify(next, null, 2), "utf8");
  } catch {
    /* best-effort; config still applies for the session */
  }
}

export function getConfig(): AppConfig {
  isManagedRegistryMode();
  if (cached) return cached;
  const d = defaults();

  if (isManagedRegistryMode()) {
    cached = {
      ...d,
      projects: loadManagedProjects(),
      orders: {},
      gamification: false,
    };
    return cached;
  }

  let onDisk:
    | (Partial<AppConfig> & { repoPath?: string; demo?: boolean })
    | null = null;
  try {
    onDisk = JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    onDisk = null;
  }

  const merged: AppConfig = {
    humanActor: onDisk?.humanActor || d.humanActor,
    humanAllowlist:
      onDisk?.humanAllowlist && onDisk.humanAllowlist.length
        ? onDisk.humanAllowlist
        : d.humanAllowlist,
    pollIntervalMs:
      typeof onDisk?.pollIntervalMs === "number" ? onDisk.pollIntervalMs : d.pollIntervalMs,
    projects: sanitizeProjects(onDisk?.projects),
    orders:
      onDisk?.orders && typeof onDisk.orders === "object" && !Array.isArray(onDisk.orders)
        ? (onDisk.orders as Record<string, Record<string, string[]>>)
        : {},
    gamification: typeof onDisk?.gamification === "boolean" ? onDisk.gamification : d.gamification,
  };

  // One-time migration: back-fill the registry from the legacy single repoPath
  // (or BEADS_REPO / cwd) when no projects array exists yet.
  let migrated = false;
  if (!onDisk || onDisk.projects === undefined) {
    const legacyPath = onDisk?.repoPath || process.env.BEADS_REPO || process.cwd();
    if (
      legacyPath &&
      hasBeads(legacyPath) &&
      !merged.projects.some((p) => sameDir(p.path, legacyPath))
    ) {
      merged.projects.push(makeEntry(legacyPath, new Set(merged.projects.map((p) => p.id))));
      migrated = true;
    }
  }

  cached = merged;
  // Persist the migrated entry so its id is stable across restarts.
  if (migrated) persist(merged);
  return cached;
}

/** Update global settings (actor / allowlist / poll). Project registry has its own mutators. */
export function saveConfig(
  patch: Partial<Pick<AppConfig, "humanActor" | "humanAllowlist" | "pollIntervalMs" | "gamification">>,
): AppConfig {
  if (isManagedRegistryMode()) {
    throw new ConfigError("Managed project configuration is immutable", "read_only");
  }
  const next = { ...getConfig(), ...patch };
  persist(next);
  return next;
}

// ---- project registry ----------------------------------------------------

export function listProjects(): ProjectEntry[] {
  return getConfig().projects;
}

export function getProject(id: string): ProjectEntry | DemoProject | undefined {
  if (isManagedRegistryMode()) {
    return getConfig().projects.find((p) => p.id === id);
  }
  if (id === DEMO_PROJECT.id) return DEMO_PROJECT;
  return getConfig().projects.find((p) => p.id === id);
}

/** Add (or re-touch) a project by folder path. Validates a `.beads` dir exists. */
export function addProject(inputPath: string): ProjectEntry {
  if (isManagedRegistryMode()) {
    throw new ConfigError("Project registration is disabled for this immutable source registry", "read_only");
  }
  const cfg = getConfig();
  const root = filesystemRoot();
  const abs = root ? canonicalPathWithinRoot(inputPath, root) : existingRealpath(inputPath);
  if (!hasBeads(abs)) {
    throw new ConfigError(`No .beads directory found in ${abs}`, "no_beads");
  }
  const existing = cfg.projects.find((p) => sameDir(p.path, abs));
  if (existing) {
    existing.lastOpened = new Date().toISOString();
    persist(cfg);
    return existing;
  }
  const entry = makeEntry(abs, new Set(cfg.projects.map((p) => p.id)));
  cfg.projects.push(entry);
  persist(cfg);
  return entry;
}

export function removeProject(id: string): void {
  if (isManagedRegistryMode()) throw new ConfigError("Managed project registry is immutable", "read_only");
  const cfg = getConfig();
  cfg.projects = cfg.projects.filter((p) => p.id !== id);
  // Drop any saved board ordering for the removed project so it can't orphan.
  if (cfg.orders[id]) {
    const rest = { ...cfg.orders };
    delete rest[id];
    cfg.orders = rest;
  }
  persist(cfg);
}

export function touchProject(id: string): void {
  const cfg = getConfig();
  const p = cfg.projects.find((x) => x.id === id);
  if (p) {
    p.lastOpened = new Date().toISOString();
    persist(cfg);
  }
}

export function renameProject(id: string, name: string): ProjectEntry | undefined {
  if (isManagedRegistryMode()) throw new ConfigError("Managed project registry is immutable", "read_only");
  const cfg = getConfig();
  const p = cfg.projects.find((x) => x.id === id);
  if (!p) return undefined;
  p.name = name;
  persist(cfg);
  return p;
}

// ---- manual board ordering ------------------------------------------------

/** All saved column orders for a project: columnId → ordered bead ids. */
export function getColumnOrders(projectId: string): Record<string, string[]> {
  return getConfig().orders[projectId] ?? {};
}

/** Replace the saved order for one column of one project. */
export function setColumnOrder(
  projectId: string,
  columnId: string,
  ids: string[],
): Record<string, string[]> {
  if (isManagedRegistryMode()) throw new ConfigError("Managed project configuration is immutable", "read_only");
  const cfg = getConfig();
  const proj = { ...(cfg.orders[projectId] ?? {}) };
  proj[columnId] = ids;
  cfg.orders = { ...cfg.orders, [projectId]: proj };
  persist(cfg);
  return proj;
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { canonicalPathWithinRoot, filesystemRoot, isManagedRegistryMode } from "@/lib/config";
import { ok, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * Read-only filesystem browser used by the "add project" folder picker.
 *
 * SECURITY: this exposes the server's directory tree to anyone who can reach it.
 * That is acceptable for a localhost, single-user dev tool (same trust model as
 * the existing `bd` shell-out) — do NOT expose this app to untrusted networks
 * without auth. Set BEADS_FS_ROOT to clamp browsing to a subtree.
 */
function hasBeads(p: string): boolean {
  try {
    return fs.existsSync(path.join(p, ".beads"));
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  try {
    if (isManagedRegistryMode()) {
      return ok({ error: "Filesystem browsing is disabled for the explicit source registry", code: "read_only" }, 403);
    }
    const url = new URL(req.url);
    const home = os.homedir();
    const root = filesystemRoot();
    const rawRequested = url.searchParams.get("path");
    // Expand a leading ~ so typed/pasted home-relative paths resolve.
    const requested =
      rawRequested === "~"
        ? home
        : rawRequested?.startsWith("~/")
          ? path.join(home, rawRequested.slice(2))
          : rawRequested;
    const targetInput = path.resolve(requested && requested.trim() ? requested : root || home);
    let target = targetInput;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return ok({ error: `Not found: ${target}`, code: "enoent" }, 400);
      }
      if (code === "EACCES") {
        return ok({ error: `Permission denied: ${target}`, code: "eacces" }, 403);
      }
      throw e;
    }
    if (!stat.isDirectory()) {
      return ok({ error: `Not a directory: ${target}`, code: "enotdir" }, 400);
    }

    target = root ? canonicalPathWithinRoot(targetInput, root) : fs.realpathSync(targetInput);

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(target, { withFileTypes: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES") {
        return ok({ error: `Permission denied: ${target}`, code: "eacces" }, 403);
      }
      throw e;
    }

    const entries = dirents
      .filter((d) => !d.name.startsWith(".") && (d.isDirectory() || d.isSymbolicLink()))
      .flatMap((d) => {
        const full = path.join(target, d.name);
        try {
          const canonical = root ? canonicalPathWithinRoot(full, root) : fs.realpathSync(full);
          if (!fs.statSync(canonical).isDirectory()) return [];
          return [{ name: d.name, path: canonical, hasBeads: hasBeads(canonical) }];
        } catch {
          // Hide symlinks that resolve outside the configured root.
          return [];
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const parent = path.dirname(target);
    const parentAllowed = !root || target !== root;

    return ok({
      path: target,
      parent: parent === target || !parentAllowed ? null : parent,
      home: root || home,
      hasBeads: hasBeads(target),
      entries,
    });
  } catch (e) {
    return fail(e);
  }
}

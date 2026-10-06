import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { BdError } from "./bd";
import { BrError } from "./br";
import { ConfigError, configuredWriteOrigin, isHardReadOnly, isManagedRegistryMode, isReadOnly } from "./config";
import { AiError } from "./ai";
import type { BeadsStore } from "./store";
import type { StoreCapabilities } from "./source";

export function ok(data: unknown, init?: number) {
  return NextResponse.json(data, { status: init ?? 200 });
}

/** Enforce the two managed project-data actions before any native writer call. */
export function assertWriteCapability(
  req: Request,
  store: BeadsStore,
  capability: keyof StoreCapabilities,
): void {
  if (isHardReadOnly() || store.source?.readOnly || isReadOnly(req)) {
    throw new ConfigError("This project is read-only in Scotty", "read_only");
  }
  if (!isManagedRegistryMode()) return;
  const origin = req.headers.get("origin");
  if (!origin || origin !== configuredWriteOrigin()) {
    throw new ConfigError("A matching Origin header is required for managed writes", "csrf_origin");
  }
  if (!store.source?.capabilities?.[capability]) {
    throw new ConfigError(`This project does not allow ${capability}`, "capability_unavailable");
  }
}

/** Same-origin guard for managed app preference mutations. */
export function assertConfiguredSameOrigin(req: Request): void {
  if (!isManagedRegistryMode()) return;
  const origin = req.headers.get("origin");
  if (!origin || origin !== configuredWriteOrigin()) {
    throw new ConfigError("A matching Origin header is required", "csrf_origin");
  }
}

/** Block machine-level operations that have no managed-project capability. */
export function assertUnmanagedOperation(): void {
  if (isManagedRegistryMode()) {
    throw new ConfigError("This operation is unavailable for managed projects", "capability_unavailable");
  }
}

export function fail(err: unknown) {
  if (err instanceof AiError && err.code === "provider_prohibited") {
    return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      { error: "Invalid input", issues: err.issues, code: "invalid_input" },
      { status: 400 },
    );
  }
  if (err instanceof BdError) {
    // A blocked write on a stale schema is a precondition conflict, not a bad
    // request: the client sent nothing wrong and retrying verbatim will work
    // once the DB is migrated. The raw bd output rides along as `detail` so the
    // UI can offer a "show technical details" expander without re-deriving it.
    if (err.code === "schema_migration_required") {
      return NextResponse.json(
        {
          error: "This project's beads database needs a one-time upgrade.",
          code: err.code,
          detail: err.message,
        },
        { status: 409 },
      );
    }
    // parse_error means bd's output drifted from our schema — a server-side
    // integration failure, not a bad client request.
    const status =
      err.code === "not_found" ? 404 : ["parse_error", "source_binding", "write_verification"].includes(err.code ?? "") ? 500 : 400;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  if (err instanceof BrError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.code === "read_only" || err.code === "capability_unavailable" ? 403 : ["parse_error", "source_binding", "write_verification"].includes(err.code ?? "") ? 500 : 400 },
    );
  }
  if (err instanceof ConfigError) {
    const status = err.code === "unknown_project" ? 404 :
      ["read_only", "capability_unavailable", "csrf_origin"].includes(err.code) ? 403 : 400;
    return NextResponse.json({ error: err.message, code: err.code }, { status });
  }
  const message = err instanceof Error ? err.message : "Internal error";
  return NextResponse.json({ error: message }, { status: 500 });
}

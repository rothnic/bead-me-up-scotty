import { NextResponse } from "next/server";
import { z } from "zod";
import { configuredWriteOrigin, isHardReadOnly, isManagedRegistryMode, isReadOnly, VIEWER_MODE_COOKIE } from "@/lib/config";
import { assertConfiguredSameOrigin, fail } from "@/lib/api";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", Vary: "Cookie" };
const input = z.object({ readOnly: z.boolean() }).strict();

export function GET(req: Request) {
  return NextResponse.json({ readOnly: isReadOnly(req), locked: isHardReadOnly() }, { headers });
}

export async function PUT(req: Request) {
  try {
    // In managed mode the configured browser origin is the authority; req.url
    // may be the internal HTTP listener even when the browser used canonical
    // HTTPS behind Caddy. Keep this inside the guarded path so bad origins are
    // deterministic 403 responses rather than uncaught 500s.
    assertConfiguredSameOrigin(req);
    // Preserve the stock app's scheme-and-host same-origin check in unmanaged
    // mode. Managed deployments use the explicit browser origin above because
    // req.url can be the internal listener behind a proxy.
    if (!isManagedRegistryMode()) {
      const origin = req.headers.get("origin");
      const requestUrl = new URL(req.url);
      const host = req.headers.get("host") ?? requestUrl.host;
      if (origin && origin !== `${requestUrl.protocol}//${host}`) {
        return NextResponse.json({ error: "Origin mismatch" }, { status: 403 });
      }
    }
    const { readOnly } = input.parse(await req.json());
    const url = new URL(req.url);
    const res = NextResponse.json({ readOnly }, { headers });
    res.cookies.set(VIEWER_MODE_COOKIE, readOnly ? "read-only" : "editing", {
      httpOnly: true, sameSite: "strict", path: "/",
      secure: isManagedRegistryMode() ? configuredWriteOrigin().startsWith("https:") : url.protocol === "https:",
      // No expires/maxAge: mode is session-scoped, unlike banner appearance.
    });
    return res;
  } catch (e) { return fail(e); }
}

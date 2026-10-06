import { getStore } from "@/lib/store";
import { getConfig, isManagedRegistryMode, ConfigError } from "@/lib/config";
import { managedPrioritySchema, updateInputSchema } from "@/lib/schema";
import { assertWriteCapability, ok, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { projectId, id } = await params;
    const store = await getStore(projectId);
    const bead = await store.get(id);
    if (!bead) return ok({ error: "not found" }, 404);
    return ok(bead);
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { projectId, id } = await params;
    const store = await getStore(projectId);
    const cfg = getConfig();
    if (isManagedRegistryMode()) {
      const patch = managedPrioritySchema.parse(await req.json());
      assertWriteCapability(req, store, "priority");
      return ok(await store.update(id, patch, cfg.humanActor));
    }
    const patch = updateInputSchema.parse(await req.json());
    const bead = await store.update(id, patch, cfg.humanActor);
    return ok(bead);
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { projectId, id } = await params;
    if (isManagedRegistryMode()) throw new ConfigError("Delete is unavailable in managed Scotty mode", "capability_unavailable");
    const store = await getStore(projectId);
    const cfg = getConfig();
    await store.remove(id, cfg.humanActor);
    return ok({ deleted: id });
  } catch (e) {
    return fail(e);
  }
}

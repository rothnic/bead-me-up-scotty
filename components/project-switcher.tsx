"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Plus, LayoutGrid, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useProjects } from "@/hooks/use-projects";
import { FolderBrowserModal } from "@/components/folder-browser-modal";
import type { StoreKind } from "@/lib/source";

export function ProjectSwitcher({
  projectId,
  projectName,
  kind,
  live,
  taskStatus,
  onNavigate,
}: {
  projectId: string;
  projectName?: string;
  kind?: StoreKind;
  /** Whether the SSE change stream is connected (real projects only). */
  live?: boolean;
  taskStatus: { loading: boolean; fetching: boolean; error?: string; updatedAt: number; hasData: boolean };
  /** Allows a containing mobile navigation Sheet to close after routing. */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const { data } = useProjects();
  const [addOpen, setAddOpen] = React.useState(false);

  const projects = data?.projects ?? [];
  const demo = projects.find((p) => p.id === "demo");
  const recents = projects.filter((p) => p.id !== "demo");
  const current = projects.find((p) => p.id === projectId);
  const currentName = projectName ?? current?.name ?? (projectId === "demo" ? "Demo" : projectId);

  const isDemo = kind === "demo" || projectId === "demo";
  const canRegister = !!data && !data.managedRegistry;
  const isLive = !isDemo && !!live;
  const updatedAt = taskStatus.updatedAt > 0
    ? new Date(taskStatus.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
  const taskLabel = taskStatus.error && taskStatus.hasData
    ? "Refresh failed - showing saved tasks"
    : taskStatus.loading
      ? "Loading tasks..."
      : taskStatus.fetching && taskStatus.hasData
        ? `Refreshing - updated ${updatedAt ?? "recently"}`
        : taskStatus.hasData
          ? `Updated ${updatedAt ?? "recently"}`
          : taskStatus.error
            ? "Could not load tasks"
            : isDemo
              ? "sample data"
              : isLive
                ? "bd - live"
                : "bd - project";
  const capabilities = current?.capabilities;
  const writableAreas = [
    ...(capabilities?.comments ? ["comments"] : []),
    ...(capabilities?.priority ? ["priority"] : []),
  ];
  const sourceDetails = [
    current?.sourceLabel,
    current?.backend ?? (kind === "bd" || kind === "br" ? kind : undefined),
    current?.database ? `database ${current.database}` : undefined,
    current?.readOnly
      ? "read-only"
      : capabilities
        ? writableAreas.length > 0
          ? `${writableAreas.join(" + ")} editable`
          : "no narrow edits"
        : undefined,
  ].filter(Boolean).join(" · ");
  const dot = (
    <span
      title={isLive ? "Live — changes stream in instantly" : undefined}
      className={
        "h-[7px] w-[7px] flex-shrink-0 rounded-full" + (isLive ? " animate-pulse" : "")
      }
      style={{
        background: isDemo ? "#d97706" : "#22c55e",
        boxShadow: `0 0 0 3px ${isDemo ? "#d9770622" : "#22c55e22"}`,
      }}
    />
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Select project, current project ${currentName}`}
          className="mb-[6px] flex w-full items-center gap-[9px] rounded-[10px] border border-border bg-[var(--surface-2)] px-[11px] py-[9px] text-left hover:bg-[var(--surface-3)] focus:outline-none"
        >
          {dot}
          <div className="min-w-0 flex-1 leading-[1.15]">
            <div className="truncate text-[13px] font-[600] text-[var(--text)]">{currentName}</div>
            <div
              role="status"
              aria-live="polite"
              title={taskStatus.error ?? (updatedAt ? `Task data updated ${new Date(taskStatus.updatedAt).toISOString()}` : undefined)}
              className={`truncate text-[10.5px] ${taskStatus.error ? "text-destructive" : "text-[var(--text-3)]"}`}
            >
              {taskLabel}
            </div>
            {sourceDetails && (
              <div title={sourceDetails} className="truncate text-[10px] text-[var(--text-3)]">
                {sourceDetails}
              </div>
            )}
          </div>
          <ChevronsUpDown size={14} className="flex-shrink-0 text-[var(--text-3)]" />
        </DropdownMenuTrigger>

        <DropdownMenuContent className="w-[210px]">
          <DropdownMenuLabel>Switch project</DropdownMenuLabel>

          {demo && (
            <DropdownMenuItem onClick={() => { onNavigate?.(); router.push("/p/demo"); }}>
              <span className="flex-1 truncate">Demo</span>
              {projectId === "demo" && <Check size={14} />}
            </DropdownMenuItem>
          )}

          {recents.length > 0 && <DropdownMenuSeparator />}
          {recents.map((p) => (
            <DropdownMenuItem key={p.id} onClick={() => { onNavigate?.(); router.push(`/p/${p.id}`); }}>
              <span
                className="h-[6px] w-[6px] flex-shrink-0 rounded-full"
                style={{ background: p.hasBeads ? "#22c55e" : "#ef4444" }}
              />
              <span className="flex-1 truncate">{p.name}</span>
              {p.id === projectId && <Check size={14} />}
            </DropdownMenuItem>
          ))}

          {canRegister && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setAddOpen(true)}>
                <Plus size={14} />
                <span>Add project…</span>
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => { onNavigate?.(); router.push("/"); }}>
            <LayoutGrid size={14} />
            <span>All projects</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {canRegister && <FolderBrowserModal open={addOpen} onOpenChange={setAddOpen} />}
    </>
  );
}

"use client";
import * as React from "react";
import { LockKeyhole } from "lucide-react";
import { useViewerMode } from "@/hooks/use-viewer-mode";
import { useApp } from "@/components/app-context";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";

const KEY = "scotty.read-only-banner";
const EVENT = "scotty:banner";
const DEFAULTS = { size: "small", background: "#fff3cd", text: "#664d03" };
const INITIAL = JSON.stringify(DEFAULTS);
let fallback = INITIAL;
function savePreferences(value: string) {
  fallback = value;
  try { localStorage.setItem(KEY, value); } catch { /* Session fallback if storage is unavailable. */ }
  window.dispatchEvent(new Event(EVENT));
}
function snapshot() {
  try { return localStorage.getItem(KEY) ?? fallback; } catch { return fallback; }
}
function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(EVENT, cb);
  return () => { window.removeEventListener("storage", cb); window.removeEventListener(EVENT, cb); };
}
function parse(raw: string) {
  try {
    const p = JSON.parse(raw);
    const color = (v: unknown, otherwise: string) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : otherwise;
    return { size: p.size === "large" ? "large" : "small", background: color(p.background, DEFAULTS.background), text: color(p.text, DEFAULTS.text) };
  } catch { return DEFAULTS; }
}

export function ReadOnlyBanner({ reserveSpace = false }: { reserveSpace?: boolean }) {
  const { data, change, isLoading } = useViewerMode();
  const { meta, canComment, canPriority } = useApp();
  const source = meta?.source;
  const managedSource = source?.managed === true;
  const sourceReadOnly = source?.readOnly === true;
  const deploymentLocked = data?.locked === true;
  const viewerReadOnly = data?.readOnly === true;
  const sourceCapabilities = meta?.capabilities ?? source?.capabilities;
  const sourceWritableAreas = [
    ...(sourceCapabilities?.comments ? ["comments"] : []),
    ...(sourceCapabilities?.priority ? ["priority"] : []),
  ];
  const hasSourceWrites = sourceWritableAreas.length > 0;
  const limitedEditing =
    managedSource && !sourceReadOnly && !deploymentLocked && !viewerReadOnly &&
    (canComment || canPriority);
  const sourceReadOnlyBanner = managedSource && (sourceReadOnly || !hasSourceWrites);
  const shouldShow = deploymentLocked || viewerReadOnly || limitedEditing || sourceReadOnlyBanner;
  const label = deploymentLocked
    ? "Editing locked by deployment"
    : viewerReadOnly
      ? "Read Only Mode"
      : limitedEditing
        ? "Limited source editing"
        : "Read-only source";
  const browserDescription =
    "Editing is disabled for this browser session. Changes here apply to tabs sharing this session, not other browsers.";
  const managedBrowserDescription = sourceReadOnly
    ? " The configured source is also read-only."
    : hasSourceWrites
      ? ` This source supports ${sourceWritableAreas.join(" and ")} when browser editing is enabled.`
      : " The managed source exposes no comment or priority writes.";
  const description = deploymentLocked
    ? "Editing is locked by the deployment for the canonical source."
    : viewerReadOnly
      ? `${browserDescription}${managedSource ? managedBrowserDescription : ""}`
      : sourceReadOnlyBanner
        ? sourceReadOnly
          ? "This configured source is read-only. Comments, priority, lifecycle, and runtime actions are unavailable."
          : "This managed source exposes no comment or priority writes. Lifecycle and runtime actions are unavailable."
        : limitedEditing
          ? `This source allows ${sourceWritableAreas.join(" and ")}. Status, claim, closure, dependency, and runtime actions remain unavailable.`
          : "Editing is disabled for this browser session. Changes here apply to tabs sharing this session, not other browsers.";
  const [open, setOpen] = React.useState(false);
  const raw = React.useSyncExternalStore(subscribe, snapshot, () => INITIAL);
  const prefs = React.useMemo(() => parse(raw), [raw]);
  const bannerHeight = prefs.size === "large" ? 48 : 28;
  function update(patch: Partial<typeof DEFAULTS>) {
    savePreferences(JSON.stringify({ ...prefs, ...patch }));
  }
  if (!shouldShow) {
    return isLoading || reserveSpace
      ? <div aria-hidden="true" className="w-full shrink-0" style={{ height: bannerHeight }} />
      : null;
  }
  return <>
    <button
      type="button" aria-label={label} title={`${label} — click for details`}
      onClick={() => setOpen(true)}
      className="flex w-full shrink-0 items-center justify-center gap-2 border-b border-black/10 px-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-[-3px]"
      style={{ backgroundColor: prefs.background, color: prefs.text, minHeight: bannerHeight, fontSize: prefs.size === "large" ? 15 : 12 }}
    >
      <LockKeyhole size={14} aria-hidden="true" />{label}
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-viewer-dialog>
        <DialogTitle>{label}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        <fieldset className="flex gap-4">
          <legend className="mb-2 font-medium">Banner size</legend>
          {["small", "large"].map((size) => <label key={size} className="flex items-center gap-2 capitalize">
            <input type="radio" name="banner-size" value={size} checked={prefs.size === size} onChange={() => update({ size })} />{size === "large" ? "Large" : "Small"}
          </label>)}
        </fieldset>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-2">Background color<input type="color" value={prefs.background} onChange={(e) => update({ background: e.target.value })} className="h-9 w-full cursor-pointer" /></label>
          <label className="flex flex-col gap-2">Text color<input type="color" value={prefs.text} onChange={(e) => update({ text: e.target.value })} className="h-9 w-full cursor-pointer" /></label>
        </div>
        <div className="rounded-md px-3 py-2 text-center font-semibold" style={{ backgroundColor: prefs.background, color: prefs.text }}>{label}</div>
        <p className="text-xs text-muted-foreground">Size and colors are saved automatically in this browser.</p>
        <button className="justify-self-start text-xs underline" onClick={() => update(DEFAULTS)}>Reset appearance</button>
        {change.error && <p role="alert" className="text-sm text-destructive">{change.error.message}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button className="rounded-md border px-3 py-2" onClick={() => setOpen(false)}>{viewerReadOnly ? "Keep read-only mode" : "Close"}</button>
          {viewerReadOnly && !deploymentLocked && <button disabled={change.isPending} className="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50" onClick={() => change.mutate(false, { onSuccess: () => setOpen(false) })}>Disable read-only mode</button>}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

export function ViewerModeSetting() {
  const { data, change, error } = useViewerMode();
  const { meta } = useApp();
  const source = meta?.source;
  const sourceWrites = [
    ...(source?.capabilities?.comments ? ["comments"] : []),
    ...(source?.capabilities?.priority ? ["priority"] : []),
  ];
  const description = data?.locked
    ? "Editing is locked by the deployment for the canonical source."
    : source?.managed
      ? source.readOnly || sourceWrites.length === 0
        ? "This configured source is read-only. The browser setting still applies to other sources in this session."
        : `The managed source allows ${sourceWrites.join(" and ")}; lifecycle and runtime actions remain unavailable. This browser setting applies to all sources in this session.`
      : "Prevent edits while you watch progress. This setting applies to your current browser session.";
  return <section className="mb-5 rounded-xl border border-border p-4">
    <h2 className="mb-2 font-semibold">Read-only mode</h2>
    <p className="mb-3 text-sm text-muted-foreground">{description}</p>
    <button disabled={!data || data.locked === true || change.isPending} className="rounded-md border px-3 py-2 text-sm disabled:opacity-50" onClick={() => change.mutate(!data?.readOnly)}>
      {data?.locked ? "Locked by deployment" : data?.readOnly ? "Disable read-only mode" : "Enable read-only mode"}
    </button>
    {(change.error || error) && <p role="alert" className="mt-2 text-sm text-destructive">{(change.error || error)?.message}</p>}
  </section>;
}

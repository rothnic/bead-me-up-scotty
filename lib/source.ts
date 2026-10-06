/**
 * Server-to-client identity for the selected beads source. This is metadata
 * only; the source CLI remains the authority for every record and edge.
 */
export type StoreKind = "bd" | "br" | "demo";

/** The only project-data mutations a managed Scotty source may expose. */
export interface StoreCapabilities {
  comments: boolean;
  priority: boolean;
}

/** Native backend/source policy supplied by the immutable project registry. */
export interface StorePolicy {
  managed?: boolean;
  readOnly?: boolean;
  capabilities?: StoreCapabilities;
  label?: string;
  scope?: string;
  nativeProjectId?: string | null;
  database?: string | null;
  city?: string;
  rig?: string;
}

export interface StoreSource {
  kind: StoreKind;
  managed: boolean;
  label: string;
  scope: string;
  root: string | null;
  cli: string | null;
  nativeProjectId: string | null;
  database: string | null;
  readOnly: boolean;
  capabilities: StoreCapabilities;
  readAt: string | null;
  newestRecordUpdatedAt: string | null;
  recordCount?: number;
  edgeCount?: number;
  statusCounts?: Record<string, number>;
  /** Resolved native authority for the latest verified operation, not a port pin. */
  route?: {
    kind: "direct" | "city" | "rig";
    city?: string;
    rig?: string;
    endpoint: { host: string; port: number } | null;
  };
}

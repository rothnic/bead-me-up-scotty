import "server-only";

export class AiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

export interface AssistInput {
  id: string;
  title: string;
  description: string;
  type: string;
  labels: string[];
  /** Candidate beads for duplicate detection (id + title only). */
  others: { id: string; title: string }[];
}
export interface AssistResult {
  description: string;
  acceptance: string;
  labels: string[];
  duplicates: { id: string; title: string; reason: string }[];
}

export async function isClaudeAvailable(): Promise<boolean> {
  return false;
}

export async function assistBead(input: AssistInput): Promise<AssistResult> {
  void input;
  throw new AiError("AI assistance is disabled because this provider is prohibited.", "provider_prohibited");
}

// Tiny in-memory ring buffer for the 诊断 report. No runtime imports (loaded by node tests).

export interface DiagLogEntry {
  t: string;
  event: string;
  data?: unknown;
}

export const DIAG_LOG_LIMIT = 200;
const MAX_FIELD_CHARS = 600;

function trim(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…(+${value.length - MAX_FIELD_CHARS})` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth > 3) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => trim(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 30)) out[key] = trim(item, depth + 1);
  return out;
}

export class DiagLog {
  private entries: DiagLogEntry[] = [];

  readonly limit: number;
  private readonly now: () => number;

  constructor(limit = DIAG_LOG_LIMIT, now: () => number = () => Date.now()) {
    this.limit = limit;
    this.now = now;
  }

  add(event: string, data?: unknown): void {
    this.entries.push(data === undefined
      ? { t: new Date(this.now()).toISOString(), event }
      : { t: new Date(this.now()).toISOString(), event, data: trim(data) });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  snapshot(): DiagLogEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.entries = [];
  }
}

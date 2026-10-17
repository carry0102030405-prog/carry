/**
 * 自动切到前台: Chrome throttles background tabs, so a provider that is generating in a
 * hidden tab can stall until the user switches to it. While a relay step waits for a reply,
 * bring that provider's tab to the front, then give the user's own tab back afterwards.
 *
 * Steps hand off without bouncing: when one step ends, the restore is delayed briefly so the
 * next step (usually starting within a second) can take the foreground directly.
 */

export interface FocusTab {
  id?: number;
  windowId: number;
  active?: boolean;
}

export interface TabFocusApi {
  /** The tab the user is looking at (active tab of the last focused window). */
  getUserTab(): Promise<FocusTab | undefined>;
  getTab(tabId: number): Promise<FocusTab | undefined>;
  /** The active tab of a given window. */
  getActiveTab(windowId: number): Promise<FocusTab | undefined>;
  activateTab(tabId: number): Promise<void>;
  focusWindow(windowId: number): Promise<void>;
  /** The Chrome window that has OS focus, or undefined when Chrome is not focused. */
  getFocusedWindowId(): Promise<number | undefined>;
  isEnabled(): Promise<boolean>;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  log?(event: string, data?: Record<string, unknown>): void;
}

export const FOCUS_RESTORE_GRACE_MS = 2500;
export const AUTO_FOREGROUND_STORAGE_KEY = 'autoForeground';

/** Missing or malformed values mean the default: on. */
export function normalizeAutoForeground(value: unknown): boolean {
  return value !== false;
}

interface Origin {
  tabId: number;
  windowId: number;
  focusedWindowId?: number;
}

export class TabFocusManager {
  private origin: Origin | undefined;
  /** Tabs of steps still waiting for a reply, oldest first. */
  private pending: { key: string; tabId: number }[] = [];
  /** Tabs this manager brought to the front (so a user's own switch is never undone). */
  private ours = new Set<number>();
  private restoreTimer: unknown;
  private chain: Promise<void> = Promise.resolve();

  private readonly api: TabFocusApi;
  private readonly graceMs: number;

  constructor(api: TabFocusApi, graceMs = FOCUS_RESTORE_GRACE_MS) {
    this.api = api;
    this.graceMs = graceMs;
  }

  /** A step starts waiting on `tabId`. Resolves once the tab has been brought forward (best effort). */
  beginStep(key: string, tabId: number | undefined): Promise<void> {
    if (tabId === undefined) return Promise.resolve();
    return this.enqueue(async () => {
      if (!(await this.api.isEnabled())) return;
      this.cancelRestore();
      this.pending = this.pending.filter((entry) => entry.key !== key);
      this.pending.push({ key, tabId });
      if (!this.origin) {
        const user = await this.api.getUserTab().catch(() => undefined);
        if (user?.id !== undefined) {
          this.origin = {
            tabId: user.id,
            windowId: user.windowId,
            focusedWindowId: await this.api.getFocusedWindowId().catch(() => undefined),
          };
        }
      }
      await this.bringForward(tabId);
    });
  }

  /** The step's reply arrived, or it failed or was stopped. */
  endStep(key: string): Promise<void> {
    return this.enqueue(async () => {
      const before = this.pending.length;
      this.pending = this.pending.filter((entry) => entry.key !== key);
      if (before === this.pending.length) return;
      const next = this.pending[this.pending.length - 1];
      if (next) {
        // Parallel steps: hand the foreground to another one still generating.
        await this.bringForward(next.tabId);
        return;
      }
      this.scheduleRestore();
    });
  }

  /** The run finished, paused for a decision, or was stopped: give the user's tab back now. */
  endRun(): Promise<void> {
    return this.enqueue(async () => {
      this.pending = [];
      this.cancelRestore();
      await this.restore();
    });
  }

  /** For diagnostics/tests. */
  state(): { origin?: Origin; pending: number[]; restoreScheduled: boolean } {
    return { origin: this.origin, pending: this.pending.map((entry) => entry.tabId), restoreScheduled: this.restoreTimer !== undefined };
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.chain.then(operation, operation).catch((error: unknown) => {
      this.api.log?.('focus.error', { error: error instanceof Error ? error.message : String(error) });
    });
    this.chain = run;
    return run;
  }

  private async bringForward(tabId: number): Promise<void> {
    const tab = await this.api.getTab(tabId).catch(() => undefined);
    if (!tab) return;
    if (!tab.active) {
      await this.api.activateTab(tabId);
      this.ours.add(tabId);
    }
    // Raise the provider's window only while Chrome itself has focus; never pull Chrome
    // in front of another application the user is working in.
    const focused = await this.api.getFocusedWindowId().catch(() => undefined);
    if (focused !== undefined && focused !== tab.windowId) await this.api.focusWindow(tab.windowId);
    this.api.log?.('focus.forward', { tabId, windowId: tab.windowId });
  }

  private scheduleRestore(): void {
    this.cancelRestore();
    this.restoreTimer = this.api.setTimer(() => {
      this.restoreTimer = undefined;
      void this.enqueue(async () => {
        if (this.pending.length) return;
        await this.restore();
      });
    }, this.graceMs);
  }

  private cancelRestore(): void {
    if (this.restoreTimer === undefined) return;
    this.api.clearTimer(this.restoreTimer);
    this.restoreTimer = undefined;
  }

  private async restore(): Promise<void> {
    const origin = this.origin;
    const ours = this.ours;
    this.origin = undefined;
    this.ours = new Set();
    if (!origin) return;
    const original = await this.api.getTab(origin.tabId).catch(() => undefined);
    if (!original) return; // the user's tab is gone
    if (!original.active) {
      // Only undo our own switch: if the user moved to some other tab meanwhile, leave it.
      const current = await this.api.getActiveTab(original.windowId).catch(() => undefined);
      if (current?.id === undefined || ours.has(current.id)) {
        await this.api.activateTab(origin.tabId);
      }
    }
    const focused = await this.api.getFocusedWindowId().catch(() => undefined);
    if (focused !== undefined && focused !== original.windowId && origin.focusedWindowId === original.windowId) {
      await this.api.focusWindow(original.windowId);
    }
    this.api.log?.('focus.restore', { tabId: origin.tabId, windowId: original.windowId });
  }
}

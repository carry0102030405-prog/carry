// Hard completion backstop: some sites keep a busy signal (spinner, Stop icon, progress bar)
// around after the answer is done. Once the reply we are tracking has had the same non-empty
// text for STABLE_REPLY_OVERRIDE_MS, treat it as finished no matter what the signals say.
// No runtime imports: loaded directly by node tests.

export const STABLE_REPLY_OVERRIDE_MS = 14_000;

export class ReplyStabilityTracker {
  private text = '';
  private changedAt = 0;
  private firstSeenAt = 0;

  readonly thresholdMs: number;

  constructor(thresholdMs = STABLE_REPLY_OVERRIDE_MS) {
    this.thresholdMs = thresholdMs;
  }

  reset(): void {
    this.text = '';
    this.changedAt = 0;
    this.firstSeenAt = 0;
  }

  /** Record the candidate reply text read at `now`. Empty reads do not reset the clock. */
  observe(text: string | null | undefined, now: number): void {
    const value = (text ?? '').trim();
    if (!value) return;
    if (value !== this.text) {
      if (!this.text) this.firstSeenAt = now;
      this.text = value;
      this.changedAt = now;
    }
  }

  get candidate(): string {
    return this.text;
  }

  get lastChangeAt(): number {
    return this.changedAt;
  }

  get firstSeen(): number {
    return this.firstSeenAt;
  }

  stableForMs(now: number): number {
    return this.text ? Math.max(0, now - this.changedAt) : 0;
  }

  shouldForceComplete(now: number): boolean {
    return Boolean(this.text) && now - this.changedAt >= this.thresholdMs;
  }
}

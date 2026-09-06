export const CONTROL_LEASE_MS = 3000;

/** Wall-time control ownership only. InputStream separately enforces the 250 ms neutralization. */
export class ControlLease {
  private lastNow: number;
  private deadline: number;
  private expiredValue = false;

  constructor(nowMs: number) {
    if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs > 2 ** 48)
      throw new RangeError("Invalid lease clock");
    this.lastNow = nowMs;
    this.deadline = nowMs + CONTROL_LEASE_MS;
  }

  observeAdmission(
    result: { renewed: boolean; admitted: number; duplicate: boolean },
    nowMs: number,
  ): boolean {
    if (this.expired(nowMs)) return false;
    if (!result.renewed || result.duplicate || result.admitted === 0) return false;
    this.deadline = nowMs + CONTROL_LEASE_MS;
    return true;
  }

  expired(nowMs: number): boolean {
    if (!Number.isFinite(nowMs) || nowMs < this.lastNow || nowMs > 2 ** 48)
      throw new RangeError("Nonmonotonic lease clock");
    this.lastNow = nowMs;
    this.expiredValue ||= nowMs >= this.deadline;
    return this.expiredValue;
  }
}

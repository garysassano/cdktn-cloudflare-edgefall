import { describe, expect, it } from "vitest";
import { ControlLease } from "../../src/worker/runtime/control-lease.js";

const fresh = { admitted: 1, renewed: true, duplicate: false };
describe("control connection lease", () => {
  it("expires at three seconds even when the transport never closes", () => {
    const lease = new ControlLease(100);
    expect(lease.expired(3099)).toBe(false);
    expect(lease.expired(3100)).toBe(true);
    expect(lease.observeAdmission(fresh, 3100)).toBe(false);
    expect(lease.expired(4000)).toBe(true);
  });
  it("renews fresh neutral commands without requiring held buttons", () => {
    const lease = new ControlLease(0);
    expect(lease.observeAdmission(fresh, 2900)).toBe(true);
    expect(lease.expired(5899)).toBe(false);
    expect(lease.expired(5900)).toBe(true);
  });
  it.each([
    { admitted: 0, renewed: false, duplicate: false },
    { admitted: 1, renewed: false, duplicate: false },
    { admitted: 0, renewed: false, duplicate: true },
  ])("does not renew on ack-only, stale or duplicate admission %#", (result) => {
    const lease = new ControlLease(0);
    expect(lease.observeAdmission(result, 2900)).toBe(false);
    expect(lease.expired(3000)).toBe(true);
  });
  it("rejects invalid/regressing runtime timestamps", () => {
    expect(() => new ControlLease(NaN)).toThrow();
    expect(() => new ControlLease(-1)).toThrow();
    expect(() => new ControlLease(2 ** 49)).toThrow();
    const lease = new ControlLease(100);
    expect(() => lease.expired(99)).toThrow();
    expect(() => lease.observeAdmission(fresh, Infinity)).toThrow();
    expect(lease.expired(100)).toBe(false);
  });
});

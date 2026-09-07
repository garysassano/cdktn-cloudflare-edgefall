import { describe, expect, it } from "vitest";
import { CONTROLLER_IDENTITY } from "../src/shared/diagnostics/controller-workload.js";
import { requireRoomAdmission } from "../src/shared/session/admission.js";

describe("bounded room admission preflight", () => {
  it("accepts all admitted phases with a matching build, including reserved results", async () => {
    const ready = {
      code: "ready",
      roomMode: "playing",
      protocolMajor: 3,
      protocolMinor: 1,
      identity: CONTROLLER_IDENTITY,
    };
    for (const roomMode of [
      "lobby",
      "loading",
      "playing",
      "intermission",
      "paused-empty",
      "completed",
    ])
      await expect(
        requireRoomAdmission(Response.json({ ...ready, roomMode }), CONTROLLER_IDENTITY),
      ).resolves.toBeUndefined();
    await expect(
      requireRoomAdmission(Response.json({ ...ready, protocolMajor: 2 }), CONTROLLER_IDENTITY),
    ).rejects.toMatchObject({ reason: "incompatible-build" });
    await expect(
      requireRoomAdmission(
        Response.json({
          ...ready,
          identity: { ...CONTROLLER_IDENTITY, contentHash: "0".repeat(64) },
        }),
        CONTROLLER_IDENTITY,
      ),
    ).rejects.toMatchObject({ reason: "incompatible-build" });
    for (const roomMode of ["expired", "recovering", "unknown"])
      await expect(
        requireRoomAdmission(Response.json({ ...ready, roomMode }), CONTROLLER_IDENTITY),
      ).rejects.toMatchObject({ reason: "protocol-error" });
  });
  it("preserves actionable denial states and treats service errors as retryable outages", async () => {
    for (const code of [
      "reservation-expired",
      "room-full",
      "in-progress",
      "profile-required",
      "room-ended",
    ])
      await expect(
        requireRoomAdmission(Response.json({ code }, { status: 409 }), CONTROLLER_IDENTITY),
      ).rejects.toMatchObject({ reason: code });
    await expect(
      requireRoomAdmission(
        new Response("upstream unavailable", { status: 502 }),
        CONTROLLER_IDENTITY,
      ),
    ).rejects.toMatchObject({ reason: "outage" });
  });
  it("cancels oversized streams and rejects malformed or unknown responses", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(2049));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      requireRoomAdmission(new Response(stream), CONTROLLER_IDENTITY),
    ).rejects.toMatchObject({ reason: "protocol-error" });
    expect(cancelled).toBe(true);
    for (const body of ["null", "[]", "not json", JSON.stringify({ code: "unexpected" })])
      await expect(
        requireRoomAdmission(new Response(body), CONTROLLER_IDENTITY),
      ).rejects.toMatchObject({ reason: "protocol-error" });
  });
});

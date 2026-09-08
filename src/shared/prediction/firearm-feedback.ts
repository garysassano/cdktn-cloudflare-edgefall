import type { ActionConfirmationKey, EventEnvelope } from "../protocol/events.js";
import { EVENT_HISTORY_TICKS, MAX_EVENT_HISTORY } from "../protocol/events.js";

export const FIREARM_FEEDBACK_MS = 100;
export interface PredictedFirearmCue {
  sequence: number;
  tick: number;
  confirmation: ActionConfirmationKey;
  markerIndex: number;
  definitionId: number;
  x: number;
  y: number;
}
export interface FirearmFeedbackItem extends PredictedFirearmCue {
  id: string;
  state: "predicted" | "confirmed" | "rejected";
  kind: "shot" | "muzzle-blocked";
  bornAtMs: number;
  presentedAtMs: number | null;
  lastPresentedAtMs: number | null;
  confirmedAtMs: number | null;
  acknowledgedAtMs: number | null;
  eventCursor: number | null;
}
export interface FeedbackBoundary {
  tick: number;
  acknowledgedSequence: number;
  eventCursor: number;
}

/** Cosmetic muzzle feedback. Only a validated contiguous event stream can confirm it. */
export class FirearmFeedback {
  readonly #items = new Map<string, FirearmFeedbackItem>();
  readonly #counts = {
    predicted: 0,
    presented: 0,
    promoted: 0,
    authoritative: 0,
    rejected: 0,
    evicted: 0,
  };
  #floorTick = 0;
  constructor(
    readonly runEpoch: number,
    readonly playerId: number,
  ) {}
  #key(cue: Pick<PredictedFirearmCue, "confirmation" | "markerIndex">) {
    const key = cue.confirmation;
    return `${this.runEpoch}:${key.playerId}:${key.controlEpoch}:${key.shotOrdinal}:${cue.markerIndex}`;
  }
  #reject(item: FirearmFeedbackItem) {
    if (item.state !== "predicted") return;
    item.state = "rejected";
    this.#counts.rejected++;
  }
  #trim(tick: number) {
    for (const [id, item] of this.#items)
      if (tick - item.tick > EVENT_HISTORY_TICKS) this.#items.delete(id);
    while (this.#items.size > MAX_EVENT_HISTORY) {
      const first = this.#items.keys().next().value;
      if (first === undefined) break;
      this.#items.delete(first);
      this.#counts.evicted++;
    }
  }
  synchronize(
    cues: readonly PredictedFirearmCue[],
    boundary: FeedbackBoundary,
    deliveredCursor: number,
    now: number,
  ) {
    const pending = new Set<string>();
    for (const cue of cues) {
      if (cue.confirmation.playerId !== this.playerId || cue.tick <= this.#floorTick) continue;
      const id = this.#key(cue);
      pending.add(id);
      const old = this.#items.get(id);
      // Reusing an ungranted ordinal after a consumed rejection is a new local attempt.
      // Moving an existing pending action to a corrected tick never restarts its flash.
      if (
        !old ||
        (old.state === "rejected" &&
          old.sequence !== cue.sequence &&
          old.sequence <= boundary.acknowledgedSequence)
      ) {
        this.#items.set(id, {
          ...structuredClone(cue),
          id,
          state: "predicted",
          kind: "shot",
          bornAtMs: now,
          presentedAtMs: null,
          lastPresentedAtMs: null,
          confirmedAtMs: null,
          acknowledgedAtMs: null,
          eventCursor: null,
        });
        this.#counts.predicted++;
      } else if (old.state === "predicted") Object.assign(old, structuredClone(cue));
    }
    for (const item of this.#items.values()) {
      if (item.sequence > 0 && item.sequence <= boundary.acknowledgedSequence)
        item.acknowledgedAtMs ??= now;
      if (item.state !== "predicted") continue;
      if (item.sequence > boundary.acknowledgedSequence) {
        if (!pending.has(item.id)) this.#reject(item);
      } else if (deliveredCursor >= boundary.eventCursor) {
        // A snapshot acknowledgment alone cannot reject a flash: its event frames may
        // arrive later. The complete snapshot-paired event prefix makes absence decisive.
        this.#reject(item);
      }
    }
    this.#trim(boundary.tick);
  }
  confirm(envelope: EventEnvelope, now: number): boolean {
    const event = envelope.event;
    if (
      event.confirmation?.playerId !== this.playerId ||
      !["shot", "muzzle-blocked"].includes(event.kind)
    )
      return false;
    if (envelope.tick <= this.#floorTick) return true;
    const cue = {
      sequence: 0,
      tick: envelope.tick,
      confirmation: event.confirmation,
      markerIndex: event.markerIndex,
      definitionId: event.definitionId,
      x: event.x,
      y: event.y,
    };
    const id = this.#key(cue),
      old = this.#items.get(id);
    if (old?.state === "confirmed") return true;
    if (old) {
      const sequence = old.sequence;
      Object.assign(old, cue, {
        sequence,
        state: "confirmed",
        kind: event.kind,
        confirmedAtMs: now,
        eventCursor: envelope.cursor,
      });
      // A flash that actually reached a rendered frame must never restart on confirmation.
      // If no frame displayed it (e.g. GPU pause), authority can still supply one exposure.
      if (old.presentedAtMs === null) old.bornAtMs = now;
      this.#counts.promoted++;
    } else {
      this.#items.set(id, {
        ...cue,
        id,
        state: "confirmed",
        kind: event.kind as "shot" | "muzzle-blocked",
        bornAtMs: now,
        presentedAtMs: null,
        lastPresentedAtMs: null,
        confirmedAtMs: now,
        acknowledgedAtMs: null,
        eventCursor: envelope.cursor,
      });
      this.#counts.authoritative++;
    }
    this.#trim(envelope.tick);
    return true;
  }
  visible(now: number): FirearmFeedbackItem[] {
    return [...this.#items.values()]
      .filter(
        (item) =>
          item.state !== "rejected" &&
          now >= item.bornAtMs &&
          now - item.bornAtMs < FIREARM_FEEDBACK_MS,
      )
      .map((item) => structuredClone(item));
  }
  /** Called after the renderer completes a frame, not merely when a draw is queued. */
  presented(ids: readonly string[], now: number) {
    for (const id of ids) {
      const item = this.#items.get(id);
      if (!item) continue;
      item.lastPresentedAtMs = now;
      if (item.presentedAtMs !== null) continue;
      item.presentedAtMs = now;
      this.#counts.presented++;
    }
  }
  reset(tick: number) {
    this.#floorTick = tick;
    for (const item of this.#items.values()) {
      this.#reject(item);
      // Keep tombstones for pending input so a repair never replays its old presentation.
      item.state = "rejected";
    }
  }
  get status() {
    return { ...this.#counts, items: structuredClone([...this.#items.values()]) };
  }
}

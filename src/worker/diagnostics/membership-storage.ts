import {
  type RoomMembership,
  createMembership,
  decodeMembership,
  recoverMembership,
} from "../../shared/session/membership.js";

/** Private SQLite ownership metadata, never returned by the diagnostic status endpoint. */
export class MembershipStorage {
  state: RoomMembership;
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS room_membership (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)",
    );
    const raw = storage.sql
      .exec<{ payload: string }>("SELECT payload FROM room_membership WHERE id = 1")
      .toArray()[0];
    this.state = raw ? recoverMembership(decodeMembership(raw.payload)) : createMembership();
    this.save(this.state);
  }
  save(state: RoomMembership): void {
    const raw = JSON.stringify(state);
    decodeMembership(raw);
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO room_membership (id, payload) VALUES (1, ?)",
      raw,
    );
    this.state = state;
  }
}

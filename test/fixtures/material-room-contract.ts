import { MATERIAL_ROOM_CASES, materialRoomProof } from "./material-room-proof.js";

/** Keep each full conformance request below the existing sixty-second harness bound. */
export function materialRoomContract(players: number) {
  if (players !== 1 && players !== 4) throw new Error("Unknown material proof party size");
  return materialRoomProof(
    MATERIAL_ROOM_CASES.filter((definition) => definition.players === players),
  );
}

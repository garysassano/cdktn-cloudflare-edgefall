import { EncounterLifecycle } from "../encounters/lifecycle.js";

/** One required physical enemy, no synthetic kill or gate-opening command. */
export const labEncounter = new EncounterLifecycle({
  id: 1,
  participants: [1],
  members: [
    {
      id: 2,
      required: true,
      critical: false,
      retreatAllowed: false,
      watchdogTicks: 180,
      ambientCleanupTicks: null,
    },
  ],
  objectives: [],
});

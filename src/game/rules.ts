/** W01 candidate values. Changing these requires new simulation/content identities. */
export const ARCADE = Object.freeze({
  width: 384,
  height: 216,
  simulationHz: 60,
  snapshotHz: 20,
  maxPlayers: 4,
  staleInputMs: 250,
  reservationMs: 90_000,
  initialLives: 3,
  initialGrenades: 10,
  respawnProtectionTicks: 120,
  boardingTicks: 12,
  reboardCooldownTicks: 30,
  vehicleSpecialHoldTicks: 30,
  jumpBufferTicks: 5,
  coyoteTicks: 4,
} as const);

export const RULE_PRESETS = Object.freeze({
  classic: Object.freeze({ footHealth: 1, tankArmor: 3, sharedContinues: 3 }),
  accessible: Object.freeze({ footHealth: 3, tankArmor: 3, sharedContinues: 9 }),
});
export type RulesetId = keyof typeof RULE_PRESETS;

export const DEFAULT_BINDINGS = Object.freeze({
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  up: ["ArrowUp", "KeyW"],
  down: ["ArrowDown", "KeyS"],
  fire: ["KeyJ", "KeyZ"],
  jump: ["Space", "KeyK", "KeyX"],
  grenade: ["KeyL", "KeyC"],
  interact: ["KeyE"],
  vehicleSpecial: ["KeyV"],
});
// Standard Gamepad mapping: A jump, X fire, B grenade, Y interact, LB special.
export const DEFAULT_GAMEPAD = Object.freeze({
  jump: 0,
  fire: 2,
  grenade: 1,
  interact: 3,
  vehicleSpecial: 4,
});

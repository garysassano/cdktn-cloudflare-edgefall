/** A keyboard-only diagnostic route: drive, reverse, jump, sweep all headings,
 * land while firing, jump again and settle. No checkpoint or world-state patching. */
export function kestrelProofKeys(tick: number, mirror = false): string[] {
  const keys: string[] = [];
  if (tick === 1) keys.push("KeyE");
  // Move to a shared safe starting area before the mirrored jump studies.
  if (tick >= 13 && tick <= 28) keys.push("ArrowRight");
  if (tick >= 29 && tick <= 36) keys.push("ArrowLeft");
  const directions = [
    ["ArrowUp"],
    ["ArrowRight", "ArrowUp"],
    ["ArrowRight"],
    ["ArrowRight", "ArrowDown"],
    ["ArrowDown"],
    ["ArrowLeft", "ArrowDown"],
    ["ArrowLeft"],
    ["ArrowLeft", "ArrowUp"],
  ];
  if (tick >= 40 && tick <= 119)
    for (const direction of directions[Math.floor((tick - 40) / 10)] ?? [])
      keys.push(
        mirror && direction === "ArrowLeft"
          ? "ArrowRight"
          : mirror && direction === "ArrowRight"
            ? "ArrowLeft"
            : direction,
      );
  if (tick === 37 || tick === 120) keys.push(mirror ? "ArrowLeft" : "ArrowRight");
  if (tick === 38 || tick === 121) keys.push("Space");
  if (tick >= 38 && tick <= 170) keys.push("KeyZ");
  return keys;
}

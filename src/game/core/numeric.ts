export const SUBPIXELS = 256;
export const MAX_POSITION = 2 ** 24;
export const MAX_SHAPE = 2 ** 16;
export const MAX_MOTION = 2 ** 16;
export const COUNTER_LIMIT = 0xfffff000;

export function integer(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

export function position(value: number): number {
  return integer(value, -MAX_POSITION, MAX_POSITION, "position");
}

export function motion(value: number): number {
  return integer(value, -MAX_MOTION, MAX_MOTION, "motion");
}

export function pixels(value: number): number {
  return position(
    integer(value, -MAX_POSITION / SUBPIXELS, MAX_POSITION / SUBPIXELS, "pixels") * SUBPIXELS,
  );
}

/** Division rounds toward zero. Return the discarded remainder when integrating motion. */
export function divide(
  numerator: number,
  denominator: number,
): { quotient: number; remainder: number } {
  integer(numerator, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "numerator");
  integer(denominator, 1, Number.MAX_SAFE_INTEGER, "denominator");
  const quotient = Math.trunc(numerator / denominator) || 0;
  return { quotient, remainder: numerator - quotient * denominator };
}

/** Swept slab bounds: |numerator| <= 2^26, denominator <= 2^17; products <= 2^43. */
export function compareContactTime(an: number, ad: number, bn: number, bd: number): -1 | 0 | 1 {
  for (const n of [an, bn]) integer(n, -(2 ** 26), 2 ** 26, "contact numerator");
  for (const d of [ad, bd]) integer(d, 1, 2 ** 17, "contact denominator");
  const left = an * bd;
  const right = bn * ad;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function nextCounter(current: number): number {
  integer(current, 0, COUNTER_LIMIT - 2, "counter requiring session rotation");
  return current + 1;
}

/** Xorshift32; only PRNG state uses 32-bit bitwise arithmetic, never world positions. */
export function randomStep(state: number): number {
  integer(state, 1, 0xffffffff, "nonzero random state");
  let next = state ^ (state << 13);
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

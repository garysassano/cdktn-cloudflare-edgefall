export type NativeChannel = "legs" | "upper" | "full-body" | "effects";
export type NativeSockets = Partial<Record<"muzzle" | "hand" | "grip", [number, number]>>;
export interface NativeContact {
  foot: "near" | "far";
  /** Contact at the start of this exposure, relative to the fixed feet root. */
  point: [number, number];
}
export interface NativeClip {
  id: string;
  channel: NativeChannel;
  mode: "loop" | "hold-last";
  exposures: Array<{ frame: string; ticks: number }>;
}
export interface NativeAtlas {
  frames: Record<
    string,
    {
      frame: { x: number; y: number; w: number; h: number };
      rotated: false;
      trimmed: false;
      spriteSourceSize: { x: number; y: number; w: number; h: number };
      sourceSize: { w: number; h: number };
    }
  >;
  meta: {
    image: string;
    size: { w: number; h: number };
    edgefall: {
      format: 2;
      sourceId: string;
      sourceSha256: string;
      root: [number, number];
      variants: string[];
      drawings: Record<
        string,
        {
          channel: NativeChannel;
          sockets?: NativeSockets;
          contact?: NativeContact;
        }
      >;
      clips: NativeClip[];
      approval: "pending";
    };
  };
}
/** A pure tick-based visual sampler. It cannot emit gameplay events. */
export function nativeExposure(clip: NativeClip, elapsedTicks: number): string {
  if (!Number.isSafeInteger(elapsedTicks) || elapsedTicks < 0)
    throw new Error("Invalid visual tick");
  const duration = clip.exposures.reduce((sum, exposure) => {
    if (!Number.isSafeInteger(exposure.ticks) || exposure.ticks <= 0)
      throw new Error("Invalid visual exposure");
    return sum + exposure.ticks;
  }, 0);
  if (duration <= 0 || !Number.isSafeInteger(duration))
    throw new Error("Empty/invalid visual clip");
  let cursor =
    clip.mode === "loop" ? elapsedTicks % duration : Math.min(elapsedTicks, duration - 1);
  for (const exposure of clip.exposures) {
    if (cursor < exposure.ticks) return exposure.frame;
    cursor -= exposure.ticks;
  }
  throw new Error("Unreachable visual exposure");
}

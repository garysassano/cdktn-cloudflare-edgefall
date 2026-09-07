import { type NativeAtlas, nativeExposure } from "../shared/animation/native.js";

function element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing native control ${id}`);
  return el as T;
}

export async function startNativeReview() {
  const response = await fetch("/assets/art/hero/operative.atlas.json");
  if (!response.ok) throw new Error("Native atlas unavailable");
  const atlas = (await response.json()) as NativeAtlas,
    data = atlas.meta.edgefall;
  const png = new Image();
  png.src = "/assets/art/hero/operative.png";
  await png.decode();
  const upper = element<HTMLSelectElement>("native-upper"),
    legs = element<HTMLSelectElement>("native-legs"),
    zoom = element<HTMLSelectElement>("native-zoom"),
    background = element<HTMLSelectElement>("native-background"),
    flip = element<HTMLInputElement>("native-flip"),
    roots = element<HTMLInputElement>("native-roots"),
    speed = element<HTMLSelectElement>("native-speed");
  for (const [id, drawing] of Object.entries(data.drawings))
    (drawing.channel === "upper" ? upper : legs).add(new Option(id, id));
  const run = data.clips.find((clip) => clip.id === "legs.run");
  if (!run) throw new Error("Missing native run clip");
  let tick = 0,
    playing = false,
    previous = 0;
  const cards = data.variants.map((variant) => {
    const card = document.createElement("figure"),
      caption = document.createElement("figcaption"),
      canvas = document.createElement("div"),
      lower = document.createElement("span"),
      higher = document.createElement("span"),
      root = document.createElement("i");
    caption.textContent = variant.toUpperCase();
    canvas.className = "native-canvas";
    lower.className = higher.className = "native-layer";
    root.className = "native-root";
    canvas.append(lower, higher, root);
    card.append(canvas, caption);
    element("native-cards").append(card);
    return { variant, canvas, lower, higher, root };
  });
  const render = () => {
    const lowerId = legs.value === "run-loop" ? nativeExposure(run, Math.floor(tick)) : legs.value;
    const scale = Number(zoom.value);
    for (const card of cards) {
      for (const [layer, id] of [
        [card.lower, lowerId],
        [card.higher, upper.value],
      ] as const) {
        const frame = atlas.frames[`${card.variant}/${id}`]?.frame;
        if (!frame) throw new Error("Missing native review frame");
        Object.assign(layer.style, {
          width: `${frame.w * scale}px`,
          height: `${frame.h * scale}px`,
          backgroundImage: 'url("/assets/art/hero/operative.png")',
          backgroundSize: `${atlas.meta.size.w * scale}px ${atlas.meta.size.h * scale}px`,
          backgroundPosition: `${-frame.x * scale}px ${-frame.y * scale}px`,
          transform: flip.checked ? "scaleX(-1)" : "none",
        });
        Object.assign(card.canvas.style, {
          width: `${frame.w * scale}px`,
          height: `${frame.h * scale}px`,
          backgroundColor: background.value,
        });
        card.root.style.left = `${(flip.checked ? frame.w - data.root[0] : data.root[0]) * scale}px`;
        card.root.style.top = `${data.root[1] * scale}px`;
        card.root.hidden = !roots.checked;
      }
    }
    element("native-status").textContent =
      `Tick ${Math.floor(tick)} · ${lowerId} + ${upper.value} · ${scale}× native pixels · Human style review pending`;
    element("native").dataset.tick = String(Math.floor(tick));
    element("native").dataset.legs = lowerId;
    element("native").dataset.ready = "true";
  };
  const pause = () => {
    playing = false;
    element("native-play").textContent = "Play run";
  };
  for (const control of [upper, legs, zoom, background, flip, roots]) control.onchange = render;
  legs.addEventListener("change", pause);
  element("native-play").onclick = () => {
    if (playing) pause();
    else {
      legs.value = "run-loop";
      playing = true;
      previous = performance.now();
      element("native-play").textContent = "Pause";
    }
    render();
  };
  element("native-step").onclick = () => {
    pause();
    tick = Math.floor(tick) + 1;
    legs.value = "run-loop";
    render();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pause();
  });
  const animate = (now: number) => {
    if (playing) {
      tick += ((Math.min(now - previous, 100) * 60) / 1000) * Number(speed.value);
      render();
    }
    previous = now;
    requestAnimationFrame(animate);
  };
  element("native-source").textContent =
    `Source SHA-256: ${data.sourceSha256}. Fixed root ${data.root.join(", ")}; untrimmed 64×64 drawings. World-tick run phase in combat; final contact and transition tuning remain open.`;
  render();
  requestAnimationFrame(animate);
}

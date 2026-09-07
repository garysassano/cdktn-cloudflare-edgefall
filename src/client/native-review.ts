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
    full = element<HTMLSelectElement>("native-body"),
    legs = element<HTMLSelectElement>("native-legs"),
    zoom = element<HTMLSelectElement>("native-zoom"),
    background = element<HTMLSelectElement>("native-background"),
    flip = element<HTMLInputElement>("native-flip"),
    roots = element<HTMLInputElement>("native-roots"),
    speed = element<HTMLSelectElement>("native-speed");
  for (const [id, drawing] of Object.entries(data.drawings))
    (drawing.channel === "upper" ? upper : drawing.channel === "full-body" ? full : legs).add(
      new Option(id, id),
    );
  for (const clip of data.clips)
    if (clip.id !== "legs.run")
      (clip.channel === "upper" ? upper : clip.channel === "full-body" ? full : legs).add(
        new Option(`Clip: ${clip.id}`, `clip:${clip.id}`),
      );
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
      body = document.createElement("span"),
      root = document.createElement("i"),
      contact = document.createElement("i"),
      hand = document.createElement("i"),
      grip = document.createElement("i");
    caption.textContent = variant.toUpperCase();
    canvas.className = "native-canvas";
    lower.className = higher.className = body.className = "native-layer";
    root.className = "native-root";
    contact.className = "native-root native-contact";
    hand.className = grip.className = "native-root native-socket";
    canvas.append(lower, higher, body, root, contact, hand, grip);
    card.append(canvas, caption);
    element("native-cards").append(card);
    return { variant, canvas, lower, higher, body, root, contact, hand, grip };
  });
  const selectedDrawing = (value: string) => {
    if (value === "run-loop") return nativeExposure(run, Math.floor(tick));
    if (!value.startsWith("clip:")) return value;
    const clip = data.clips.find((clip) => clip.id === value.slice(5));
    if (!clip) throw new Error("Missing selected native clip");
    const duration = clip.exposures.reduce((sum, exposure) => sum + exposure.ticks, 0);
    // The workbench repeats one-shot clips with a visible hold between cycles.
    return nativeExposure(
      clip,
      clip.mode === "loop" ? Math.floor(tick) : Math.floor(tick) % (duration + 4),
    );
  };
  const render = () => {
    const bodyId = full.value ? selectedDrawing(full.value) : null,
      lowerId = bodyId ? null : selectedDrawing(legs.value),
      upperId = bodyId ? null : selectedDrawing(upper.value);
    upper.disabled = legs.disabled = Boolean(bodyId);
    const scale = Number(zoom.value);
    for (const card of cards) {
      for (const [layer, id] of [
        [card.lower, lowerId],
        [card.higher, upperId],
        [card.body, bodyId],
      ] as const) {
        layer.hidden = !id;
        if (!id) continue;
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
        const contact = lowerId ? data.drawings[lowerId]?.contact : null;
        card.contact.hidden = !roots.checked || !contact;
        if (contact) {
          const x = data.root[0] + contact.point[0];
          card.contact.style.left = `${(flip.checked ? frame.w - x : x) * scale}px`;
          card.contact.style.top = `${data.root[1] * scale}px`;
        }
        const sockets = data.drawings[bodyId ?? upperId ?? ""]?.sockets;
        for (const name of ["hand", "grip"] as const) {
          const point = sockets?.[name];
          card[name].hidden = !roots.checked || !point;
          if (!point) continue;
          const x = data.root[0] + point[0];
          card[name].style.left = `${(flip.checked ? frame.w - x : x) * scale}px`;
          card[name].style.top = `${(data.root[1] + point[1]) * scale}px`;
        }
      }
    }
    element("native-status").textContent =
      `Tick ${Math.floor(tick)} · ${bodyId ?? `${lowerId} + ${upperId}`} · ${scale}× native pixels · Human style review pending`;
    element("native").dataset.tick = String(Math.floor(tick));
    element("native").dataset.legs = lowerId ?? "";
    element("native").dataset.upper = upperId ?? "";
    element("native").dataset.body = bodyId ?? "";
    element("native").dataset.ready = "true";
  };
  const pause = () => {
    playing = false;
    element("native-play").textContent = "Play selection";
  };
  for (const control of [upper, legs, full, zoom, background, flip, roots])
    control.onchange = render;
  legs.addEventListener("change", pause);
  element("native-play").onclick = () => {
    if (playing) pause();
    else {
      playing = true;
      previous = performance.now();
      element("native-play").textContent = "Pause";
    }
    render();
  };
  element("native-step").onclick = () => {
    pause();
    tick = Math.floor(tick) + 1;
    render();
  };
  element("native-reset").onclick = () => {
    pause();
    tick = 0;
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
    `Source SHA-256: ${data.sourceSha256}. Fixed root ${data.root.join(", ")}; untrimmed 64×64 drawings. Green marks the authored run contact at each exposure boundary. Combat clocks advance with accepted ticks and reconstruct during recording replay. Human motion review remains open.`;
  render();
  requestAnimationFrame(animate);
}

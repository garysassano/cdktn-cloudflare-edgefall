/** Offline companion for the downloaded review assets; it performs no network requests. */
export function reviewMatrixViewer(runs) {
  const movies = runs.flatMap((run) =>
    run.movies.map(({ name, duration, speed, debug, music, reduced }) => ({
      players: run.players,
      name,
      duration,
      speed,
      debug,
      music,
      reduced,
    })),
  );
  const data = JSON.stringify(movies).replaceAll("<", "\\u003c");
  const chapters = JSON.stringify(
    Object.fromEntries(runs.map((run) => [run.players, run.chapters])),
  ).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Breakwater review</title>
<style>
:root { color-scheme: dark; font: 16px/1.5 system-ui, sans-serif; background: #111820; color: #e8edf1; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1280px; padding: 24px; }
h1 { font-size: clamp(1.8rem, 4vw, 3rem); margin: 0; letter-spacing: -.04em; }
h2 { font-size: 1.2rem; margin-top: 32px; }
p { max-width: 80ch; }
header p, #capture-details, figcaption { color: #acbdcb; }
.controls { display: flex; flex-wrap: wrap; gap: 16px; margin: 24px 0 16px; }
.chapters { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
.chapters button { padding: 6px 12px; font: inherit; font-size: .9rem; border: 1px solid #61717e; border-radius: 4px; background: #202c38; color: inherit; cursor: pointer; }
.chapters button:disabled { opacity: .5; cursor: default; }
label { display: grid; gap: 6px; font-size: .9rem; }
select { min-width: 140px; padding: 8px; font: inherit; border: 1px solid #61717e; border-radius: 4px; background: #202c38; color: inherit; }
a { color: #8ad5ff; text-underline-offset: .2em; }
video { display: block; width: 768px; max-width: 100%; height: auto; background: #000; image-rendering: pixelated; outline: 1px solid #61717e; }
figure { margin: 0; overflow-x: auto; }
img { display: block; max-width: none; image-rendering: pixelated; }
figcaption { margin: 10px 0; font-size: .9rem; }
summary { cursor: pointer; padding: 12px 0; }
#error { padding: 12px; border-left: 3px solid #f3b06b; }
:focus-visible { outline: 3px solid #8ad5ff; outline-offset: 3px; }
</style>
</head>
<body>
<header>
<h1>Breakwater review</h1>
<p>48 recorded views of the current benchmark. Compare party size, playback, overlays, music and effects. Changing a view starts its recording from the beginning.</p>
</header>
<main>
<div class="controls">
<label>Players<select id="players"><option value="1">Solo</option><option value="2">Two players</option><option value="4">Four players</option></select></label>
<label>Playback<select id="speed"><option value="1">Normal</option><option value="0.25">Quarter speed</option></select></label>
<label>Overlays<select id="debug"><option value="false">Clean</option><option value="true">Debug</option></select></label>
<label>Music<select id="music"><option value="true">Enabled</option><option value="false">Muted</option></select></label>
<label>Effects<select id="reduced"><option value="false">Full</option><option value="true">Reduced</option></select></label>
</div>
<nav id="chapters" class="chapters" aria-label="Scene jumps"></nav>
<video id="movie" controls playsinline preload="metadata" aria-label="Selected mission recording"></video>
<p id="capture-details" aria-live="polite"></p>
<p id="error" hidden>The selected movie could not be loaded. Keep this page and every downloaded MP4 in the same directory. You can also open the movie directly below.</p>
<p><a id="open-movie">Open this MP4</a> · <a id="open-raw">Raw WebM</a> · <a href="artifacts.json">Integrity manifest</a></p>
<p>Scene jumps pause shortly before the selected event. Press Play to inspect its motion.</p>
<h2>Weapon comparison</h2>
<p>Each column isolates one accepted weapon action at release and 2, 4 and 6 ticks later. These compositions use the actual source pixels and accepted actor poses. The movies show the complete scene and timing.</p>
<figure>
<img src="weapons-black-1x.png" width="1200" height="488" alt="Sidearm, heavy machine gun, shotgun, grenade and flamethrower source compositions at four accepted ticks">
<figcaption>Native pixels on black. Scroll horizontally on a narrow screen.</figcaption>
</figure>
<p>Enlarged sheets: <a href="weapons-black-4x.png">black</a> · <a href="weapons-white-4x.png">white</a> · <a href="weapons-chroma-4x.png">chroma</a>. Native alternatives: <a href="weapons-white-1x.png">white</a> · <a href="weapons-chroma-1x.png">chroma</a>.</p>
<details>
<summary>Review prompts and capture scope</summary>
<p>Assess silhouette and readability, pixel discipline, motion and acting, weapon distinction, vehicle weight, environment separation, multiplayer clarity and audio impact. The current candidates are awaiting human acceptance.</p>
<p>The movies retain browser canvas and WebAudio output. Quarter-speed views were recorded during actual quarter-speed playback. Physical speakers, headphones, controller feel and online play require their own checks.</p>
<p>The manifest identifies the source sheets and detailed operative, tank and audio evidence retained in the repository.</p>
</details>
</main>
<script>
const movies = ${data};
const chapters = ${chapters};
const controls = ["players", "speed", "debug", "music", "reduced"].map(id => document.getElementById(id));
const video = document.getElementById("movie");
function selectMovie() {
  const [players, speed, debug, music, reduced] = controls.map(control => control.value);
  const movie = movies.find(item => item.players === Number(players) && item.speed === Number(speed) && item.debug === (debug === "true") && item.music === (music === "true") && item.reduced === (reduced === "true"));
  if (!movie) throw new Error("Missing review combination");
  video.pause();
  video.src = movie.name + ".mp4";
  video.load();
  document.getElementById("error").hidden = true;
  document.getElementById("open-movie").href = movie.name + ".mp4";
  document.getElementById("open-raw").href = movie.name + ".webm";
  document.getElementById("capture-details").textContent = movie.name + " · " + movie.duration.toFixed(2) + " seconds";
  document.getElementById("chapters").replaceChildren(...chapters[players].map(chapter => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = chapter.label;
    button.disabled = video.readyState < 1;
    button.addEventListener("click", () => {
      video.pause();
      video.currentTime = Math.max(0, Math.min(video.duration - .05, chapter.tick / 60 / movie.speed - 1));
    });
    return button;
  }));
}
video.addEventListener("error", () => { document.getElementById("error").hidden = false; });
video.addEventListener("loadedmetadata", () => {
  document.getElementById("error").hidden = true;
  for (const button of document.querySelectorAll("#chapters button")) button.disabled = false;
});
for (const control of controls) control.addEventListener("change", selectMovie);
selectMovie();
</script>
</body>
</html>
`;
}

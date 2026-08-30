import {
  type CombatEvent,
  type EnemyState,
  type GameState,
  type InputFrame,
  type PlayerState,
  type ServerMessage,
  UPGRADE_COPY,
  type UpgradeId,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "../game/protocol.js";

interface RenderEntity {
  x: number;
  y: number;
}

interface Particle {
  age: number;
  color: string;
  life: number;
  size: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
}

const canvas = element<HTMLCanvasElement>("game");
const context = requireCanvasContext(canvas);

const landing = element<HTMLDialogElement>("landing");
const lobby = element<HTMLDialogElement>("lobby");
const upgradeDialog = element<HTMLDialogElement>("upgrade");
const endingDialog = element<HTMLDialogElement>("ending");
const playerNameInput = element<HTMLInputElement>("playerName");
const roomCodeInput = element<HTMLInputElement>("roomCode");
const hud = element<HTMLElement>("hud");
const party = element<HTMLElement>("party");
const bossHud = element<HTMLElement>("bossHud");
const bossHealth = element<HTMLElement>("bossHealth");
const phaseLabel = element<HTMLElement>("phase");
const objectiveLabel = element<HTMLElement>("objective");
const roomLabel = element<HTMLElement>("roomLabel");
const lobbyCode = element<HTMLElement>("lobbyCode");
const upgradeCards = element<HTMLElement>("upgradeCards");
const toast = element<HTMLElement>("toast");

let socket: WebSocket | undefined;
let playerId = "";
let game: GameState | undefined;
let previousPhase: GameState["phase"] | undefined;
let currentRoom = "";
let sequence = 0;
let scale = 1;
let offsetX = 0;
let offsetY = 0;
let mouseX = window.innerWidth / 2;
let mouseY = window.innerHeight / 2;
let attackHeld = false;
let dashPulse = false;
let shake = 0;
let toastTimer: number | undefined;
let audioContext: AudioContext | undefined;
const keys = new Set<string>();
const renderEntities = new Map<string, RenderEntity>();
const particles: Particle[] = [];
const seenEvents = new Set<string>();

roomCodeInput.value = new URL(location.href).searchParams.get("room") ?? createRoomCode();
playerNameInput.value = localStorage.getItem("edgefall-name") ?? "";
closeDialog(landing);
openDialog(landing);

element("newRoomButton").addEventListener("click", () => {
  roomCodeInput.value = createRoomCode();
});
element("enterButton").addEventListener("click", connect);
element("startButton").addEventListener("click", () => send({ type: "start" }));
element("restartButton").addEventListener("click", () => send({ type: "restart" }));
element("copyButton").addEventListener("click", copyInvite);
element("shareButton").addEventListener("click", copyResult);

window.addEventListener("resize", resize);
window.addEventListener("keydown", (event) => {
  if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
    event.preventDefault();
  }
  keys.add(event.code);
  if (event.code === "Space" && !event.repeat) dashPulse = true;
});
window.addEventListener("keyup", (event) => keys.delete(event.code));
canvas.addEventListener("pointermove", (event) => {
  mouseX = event.clientX;
  mouseY = event.clientY;
});
canvas.addEventListener("pointerdown", (event) => {
  if (event.button === 0) attackHeld = true;
  canvas.setPointerCapture(event.pointerId);
  ensureAudio();
});
canvas.addEventListener("pointerup", (event) => {
  if (event.button === 0) attackHeld = false;
});
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

setInterval(sendInput, 50);
resize();
requestAnimationFrame(render);

function connect(): void {
  const room = roomCodeInput.value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 24);
  if (room.length < 3) {
    showToast("Invite code needs at least three characters");
    return;
  }

  const playerName = playerNameInput.value.trim() || "Riftwalker";
  localStorage.setItem("edgefall-name", playerName);
  currentRoom = room;
  const nextUrl = new URL(location.href);
  nextUrl.searchParams.set("room", room);
  history.replaceState(null, "", nextUrl);

  socket?.close();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(
    `${protocol}//${location.host}/rooms/${encodeURIComponent(room)}?name=${encodeURIComponent(playerName)}`,
  );
  socket.addEventListener("open", () => showToast("Connected to the rift"));
  socket.addEventListener("message", receive);
  socket.addEventListener("close", () => showToast("The rift connection closed"));
  socket.addEventListener("error", () => showToast("Could not enter this rift"));

  closeDialog(landing);
  hud.hidden = false;
  party.hidden = false;
  roomLabel.textContent = room.toUpperCase();
  lobbyCode.textContent = room.toUpperCase();
  ensureAudio();
}

function receive(event: MessageEvent<string>): void {
  let message: ServerMessage;
  try {
    message = JSON.parse(event.data);
  } catch {
    showToast("Received an unreadable rift signal");
    return;
  }

  if (message.type === "error") {
    showToast(message.message);
    return;
  }
  if (message.type === "welcome") {
    playerId = message.playerId;
    currentRoom = message.roomCode;
    return;
  }

  game = message.state;
  ingestEvents(game.events);
  updateInterface(game);
}

function sendInput(): void {
  if (!game || !playerId || socket?.readyState !== WebSocket.OPEN) return;
  const player = game.players[playerId];
  if (!player) return;
  const worldMouseX = (mouseX - offsetX) / scale;
  const worldMouseY = (mouseY - offsetY) / scale;
  const aimX = worldMouseX - player.x;
  const aimY = worldMouseY - player.y;
  const aimLength = Math.hypot(aimX, aimY) || 1;
  const input: InputFrame = {
    aimX: aimX / aimLength,
    aimY: aimY / aimLength,
    attack: attackHeld,
    dash: dashPulse,
    down: keys.has("KeyS") || keys.has("ArrowDown"),
    left: keys.has("KeyA") || keys.has("ArrowLeft"),
    right: keys.has("KeyD") || keys.has("ArrowRight"),
    sequence,
    up: keys.has("KeyW") || keys.has("ArrowUp"),
  };
  sequence += 1;
  dashPulse = false;
  send({ type: "input", input });
}

function send(message: import("../game/protocol.js").ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function updateInterface(state: GameState): void {
  phaseLabel.textContent = state.phase.toUpperCase();
  objectiveLabel.textContent = objectiveFor(state);
  renderParty(state);

  const boss = state.enemies.find((enemy) => enemy.kind === "boss");
  bossHud.hidden = !boss;
  if (boss) bossHealth.style.width = `${Math.max(0, (boss.hp / boss.maxHp) * 100)}%`;

  if (state.phase === previousPhase) return;
  previousPhase = state.phase;
  closeDialog(lobby);
  closeDialog(upgradeDialog);
  closeDialog(endingDialog);

  if (state.phase === "lobby") openDialog(lobby);
  if (state.phase === "choice") showUpgradeChoices(state);
  if (state.phase === "victory" || state.phase === "defeat") showEnding(state);
}

function renderParty(state: GameState): void {
  party.replaceChildren();
  for (const player of Object.values(state.players)) {
    const member = document.createElement("div");
    member.className = "party__member";
    member.style.setProperty("--player-color", player.color);

    const swatch = document.createElement("i");
    swatch.className = "party__swatch";
    const name = document.createElement("span");
    name.className = "party__name";
    name.textContent = player.name + (player.id === playerId ? " · YOU" : "");
    const lives = document.createElement("span");
    lives.className = "party__lives";
    lives.textContent = `◆${player.lives}`;
    const health = document.createElement("span");
    health.className = "party__health";
    const healthValue = document.createElement("i");
    healthValue.style.width = `${Math.max(0, (player.hp / player.maxHp) * 100)}%`;
    health.append(healthValue);
    member.append(swatch, name, lives, health);
    party.append(member);
  }
}

function showUpgradeChoices(state: GameState): void {
  upgradeCards.replaceChildren();
  const localPlayer = state.players[playerId];
  for (const upgrade of state.upgradeChoices) {
    const copy = UPGRADE_COPY[upgrade];
    const button = document.createElement("button");
    button.className = "upgrade-card";
    button.disabled = Boolean(localPlayer?.upgrades.length);
    const name = document.createElement("strong");
    name.textContent = copy.name;
    const description = document.createElement("span");
    description.textContent = copy.description;
    button.append(name, description);
    button.addEventListener("click", () => send({ type: "choose", upgrade }));
    upgradeCards.append(button);
  }
  openDialog(upgradeDialog);
}

function showEnding(state: GameState): void {
  const victory = state.phase === "victory";
  element("endingEyebrow").textContent = victory
    ? "THE WARDEN HAS FALLEN"
    : "THE RIFT CONSUMES ALL";
  element("endingTitle").textContent = victory ? "RUN COMPLETE" : "PARTY LOST";
  element("endingCopy").textContent = victory
    ? `Your party sealed ${currentRoom.toUpperCase()} in ${formatTime(state.elapsed)}.`
    : "Reform your party, change your blessing, and cut a cleaner path through the ash host.";
  openDialog(endingDialog);
  tone(victory ? 660 : 110, victory ? 0.5 : 0.8, victory ? "sine" : "sawtooth");
}

function showUpgradeName(upgrade: UpgradeId): string {
  return UPGRADE_COPY[upgrade].name;
}

function objectiveFor(state: GameState): string {
  if (state.phase === "lobby") return "Gather your party";
  if (state.phase === "wave") return `${state.enemies.length} ashbound remain`;
  if (state.phase === "choice") return "Claim one rift blessing";
  if (state.phase === "boss") return "Break the Rift Warden";
  if (state.phase === "victory") return `Rift sealed in ${formatTime(state.elapsed)}`;
  return "The party has fallen";
}

function ingestEvents(events: CombatEvent[]): void {
  for (const event of events) {
    const key = `${game?.runId}:${event.id}`;
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    if (seenEvents.size > 500) seenEvents.clear();
    createParticles(event);
    if (["hit", "player-hit", "boss-cleave", "boss-slam"].includes(event.type)) {
      shake = Math.max(shake, event.type.startsWith("boss") ? 18 : 6);
    }
    if (event.type === "hit") tone(190, 0.045, "square", 0.035);
    if (event.type === "player-hit") tone(92, 0.11, "sawtooth", 0.055);
    if (event.type === "boss-slam") tone(54, 0.32, "sawtooth", 0.07);
  }
}

function createParticles(event: CombatEvent): void {
  const count = event.type === "enemy-down" ? 18 : event.type.startsWith("boss") ? 28 : 9;
  const color =
    event.type === "player-hit" ? "#ff435f" : event.type === "dash" ? "#8f7dff" : "#ff9b54";
  for (let index = 0; index < count; index += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 50 + Math.random() * 230;
    particles.push({
      age: 0,
      color,
      life: 0.24 + Math.random() * 0.45,
      size: 2 + Math.random() * 5,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      x: event.x,
      y: event.y,
    });
  }
}

function render(time: number): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const pixelRatio = Math.min(devicePixelRatio, 2);
  if (canvas.width !== width * pixelRatio || canvas.height !== height * pixelRatio) resize();

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  scale = Math.min(width / WORLD_WIDTH, height / WORLD_HEIGHT);
  offsetX = (width - WORLD_WIDTH * scale) / 2;
  offsetY = (height - WORLD_HEIGHT * scale) / 2;

  const shakeX = (Math.random() - 0.5) * shake;
  const shakeY = (Math.random() - 0.5) * shake;
  shake *= 0.86;
  context.save();
  context.translate(offsetX + shakeX, offsetY + shakeY);
  context.scale(scale, scale);
  drawArena(context, time);
  if (game) {
    drawTelegraphs(context, game);
    for (const enemy of game.enemies) drawEnemy(context, enemy, time);
    for (const player of Object.values(game.players)) drawPlayer(context, player, time);
    drawParticles(context, 1 / 60);
  }
  context.restore();
  requestAnimationFrame(render);
}

function drawArena(ctx: CanvasRenderingContext2D, time: number): void {
  const gradient = ctx.createRadialGradient(800, 430, 80, 800, 430, 900);
  gradient.addColorStop(0, "#21161f");
  gradient.addColorStop(0.58, "#100d12");
  gradient.addColorStop(1, "#080709");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

  ctx.strokeStyle = "rgba(255, 246, 237, 0.045)";
  ctx.lineWidth = 1;
  for (let x = 80; x < WORLD_WIDTH; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, WORLD_HEIGHT);
    ctx.stroke();
  }
  for (let y = 50; y < WORLD_HEIGHT; y += 80) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(WORLD_WIDTH, y);
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
  ctx.rotate(time * 0.000035);
  ctx.strokeStyle = "rgba(143, 125, 255, 0.16)";
  ctx.lineWidth = 3;
  for (const radius of [120, 330, 560]) {
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0.18, Math.PI * 1.72);
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = "rgba(255, 94, 31, 0.3)";
  ctx.lineWidth = 3;
  ctx.strokeRect(36, 36, WORLD_WIDTH - 72, WORLD_HEIGHT - 72);
}

function drawTelegraphs(ctx: CanvasRenderingContext2D, state: GameState): void {
  const boss = state.enemies.find((enemy) => enemy.kind === "boss");
  if (!boss?.mode.startsWith("windup")) return;
  const pulse = 0.26 + Math.sin(performance.now() * 0.018) * 0.1;
  ctx.save();
  ctx.fillStyle = `rgba(255, 67, 95, ${pulse})`;
  ctx.strokeStyle = "rgba(255, 130, 90, 0.9)";
  ctx.lineWidth = 3;
  if (boss.mode === "windup-cleave") {
    ctx.beginPath();
    ctx.moveTo(boss.x, boss.y);
    ctx.arc(boss.x, boss.y, 285, boss.angle - 0.65, boss.angle + 0.65);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(boss.x, boss.y, 390, 0, Math.PI * 2);
    ctx.arc(boss.x, boss.y, 135, 0, Math.PI * 2, true);
    ctx.fill("evenodd");
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlayer(ctx: CanvasRenderingContext2D, player: PlayerState, time: number): void {
  const render = smoothEntity(player);
  const bob = player.hp > 0 ? Math.sin(time * 0.009 + hashNumber(player.id)) * 2.2 : 0;
  ctx.save();
  ctx.translate(render.x, render.y);

  ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
  ctx.beginPath();
  ctx.ellipse(0, 18, 30, 12, 0, 0, Math.PI * 2);
  ctx.fill();

  if (player.hp <= 0) {
    ctx.globalAlpha = 0.38;
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.rotate(player.angle);
  }

  if (player.invulnerable > 0 && Math.floor(player.invulnerable * 14) % 2 === 0)
    ctx.globalAlpha = 0.35;
  ctx.translate(0, bob);

  ctx.fillStyle = player.color;
  ctx.beginPath();
  ctx.moveTo(-19, -18);
  ctx.lineTo(-30, 23);
  ctx.lineTo(0, 14);
  ctx.lineTo(17, -16);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#211923";
  ctx.beginPath();
  ctx.roundRect(-15, -18, 31, 42, 8);
  ctx.fill();
  ctx.strokeStyle = player.color;
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = "#fff6ed";
  ctx.beginPath();
  ctx.arc(1, -25, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#171218";
  ctx.fillRect(4, -29, 10, 4);

  const attackProgress = player.attackAnimation > 0 ? 1 - player.attackAnimation / 0.28 : 0;
  const swing = player.attackAnimation > 0 ? -1.4 + easeOut(attackProgress) * 2.75 : -0.42;
  ctx.save();
  ctx.translate(8, -2);
  ctx.rotate(swing);
  ctx.strokeStyle = "#f4d4b1";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(23, 0);
  ctx.stroke();
  ctx.strokeStyle = "#fff6ed";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(17, 0);
  ctx.lineTo(68, 0);
  ctx.stroke();
  ctx.strokeStyle = player.color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(26, -6);
  ctx.lineTo(26, 6);
  ctx.stroke();
  ctx.restore();

  ctx.restore();
  drawHealthBar(ctx, render.x, render.y - 58, player.hp, player.maxHp, player.color, 54);
}

function drawEnemy(ctx: CanvasRenderingContext2D, enemy: EnemyState, time: number): void {
  const render = smoothEntity(enemy);
  ctx.save();
  ctx.translate(render.x, render.y);
  if (enemy.kind === "boss") drawBoss(ctx, enemy, time);
  else if (enemy.kind === "brute") drawBrute(ctx, enemy, time);
  else drawWisp(ctx, enemy, time);
  ctx.restore();

  if (enemy.kind === "boss")
    drawHealthBar(ctx, render.x, render.y - 105, enemy.hp, enemy.maxHp, "#ff5e1f", 135);
}

function drawWisp(ctx: CanvasRenderingContext2D, enemy: EnemyState, time: number): void {
  const pulse = 1 + Math.sin(time * 0.012 + hashNumber(enemy.id)) * 0.08;
  ctx.scale(pulse, pulse);
  ctx.fillStyle = "rgba(143, 125, 255, 0.18)";
  ctx.beginPath();
  ctx.arc(0, 0, 33, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#8f7dff";
  ctx.beginPath();
  ctx.moveTo(0, -24);
  ctx.lineTo(20, 10);
  ctx.lineTo(0, 24);
  ctx.lineTo(-20, 10);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#fff6ed";
  ctx.fillRect(-8, -4, 5, 4);
  ctx.fillRect(3, -4, 5, 4);
}

function drawBrute(ctx: CanvasRenderingContext2D, enemy: EnemyState, time: number): void {
  ctx.rotate(Math.sin(time * 0.006 + hashNumber(enemy.id)) * 0.04);
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.beginPath();
  ctx.ellipse(0, 24, 40, 14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#3b2a38";
  ctx.beginPath();
  ctx.roundRect(-34, -30, 68, 62, 13);
  ctx.fill();
  ctx.strokeStyle = "#cf6f50";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = "#ffb15c";
  ctx.fillRect(-13, -12, 8, 6);
  ctx.fillRect(5, -12, 8, 6);
}

function drawBoss(ctx: CanvasRenderingContext2D, boss: EnemyState, time: number): void {
  const windup = boss.mode.startsWith("windup");
  const pulse = windup ? 1 + Math.sin(time * 0.025) * 0.04 : 1;
  ctx.scale(pulse, pulse);
  ctx.fillStyle = "rgba(0, 0, 0, 0.52)";
  ctx.beginPath();
  ctx.ellipse(0, 48, 88, 24, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#291d29";
  ctx.beginPath();
  ctx.moveTo(-58, -42);
  ctx.lineTo(-74, 53);
  ctx.lineTo(0, 76);
  ctx.lineTo(74, 53);
  ctx.lineTo(58, -42);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = windup ? "#ff435f" : "#ff5e1f";
  ctx.lineWidth = 6;
  ctx.stroke();

  ctx.fillStyle = "#6f6570";
  ctx.beginPath();
  ctx.moveTo(-45, -48);
  ctx.lineTo(-28, -82);
  ctx.lineTo(0, -96);
  ctx.lineTo(28, -82);
  ctx.lineTo(45, -48);
  ctx.lineTo(34, -8);
  ctx.lineTo(-34, -8);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ff7a45";
  ctx.fillRect(-23, -51, 46, 8);

  const weaponAngle = boss.mode === "windup-cleave" ? -1.25 : boss.mode === "recover" ? 0.9 : -0.45;
  ctx.save();
  ctx.translate(43, -10);
  ctx.rotate(weaponAngle);
  ctx.strokeStyle = "#b9aaa2";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.moveTo(-7, 0);
  ctx.lineTo(108, 0);
  ctx.stroke();
  ctx.fillStyle = "#ff5e1f";
  ctx.beginPath();
  ctx.moveTo(85, -21);
  ctx.lineTo(129, 0);
  ctx.lineTo(85, 21);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  hp: number,
  maxHp: number,
  color: string,
  width: number,
): void {
  ctx.fillStyle = "rgba(9, 7, 10, 0.78)";
  ctx.fillRect(x - width / 2, y, width, 5);
  ctx.fillStyle = color;
  ctx.fillRect(x - width / 2, y, width * Math.max(0, hp / maxHp), 5);
}

function drawParticles(ctx: CanvasRenderingContext2D, delta: number): void {
  for (const particle of particles) {
    particle.age += delta;
    particle.x += particle.vx * delta;
    particle.y += particle.vy * delta;
    particle.vx *= 0.94;
    particle.vy *= 0.94;
    ctx.globalAlpha = Math.max(0, 1 - particle.age / particle.life);
    ctx.fillStyle = particle.color;
    ctx.fillRect(particle.x, particle.y, particle.size, particle.size);
  }
  ctx.globalAlpha = 1;
  for (let index = particles.length - 1; index >= 0; index -= 1) {
    if ((particles[index]?.age ?? 0) >= (particles[index]?.life ?? 0)) particles.splice(index, 1);
  }
}

function smoothEntity(entity: { id: string; x: number; y: number }): RenderEntity {
  const current = renderEntities.get(entity.id) ?? { x: entity.x, y: entity.y };
  current.x += (entity.x - current.x) * 0.28;
  current.y += (entity.y - current.y) * 0.28;
  renderEntities.set(entity.id, current);
  return current;
}

function resize(): void {
  const ratio = Math.min(devicePixelRatio, 2);
  canvas.width = Math.floor(canvas.clientWidth * ratio);
  canvas.height = Math.floor(canvas.clientHeight * ratio);
}

function ensureAudio(): void {
  audioContext ??= new AudioContext();
  if (audioContext.state === "suspended") void audioContext.resume();
}

function tone(frequency: number, duration: number, type: OscillatorType, volume = 0.04): void {
  if (!audioContext) return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(
    Math.max(30, frequency * 0.72),
    audioContext.currentTime + duration,
  );
  gain.gain.setValueAtTime(volume, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + duration);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + duration);
}

async function copyInvite(): Promise<void> {
  const url = new URL(location.href);
  url.searchParams.set("room", currentRoom);
  await copyText(url.toString(), "Invite link copied");
}

async function copyResult(): Promise<void> {
  const result = game?.phase === "victory" ? "sealed" : "was consumed by";
  const upgrades = game?.players[playerId]?.upgrades.map(showUpgradeName).join(", ");
  await copyText(
    `My party ${result} the ${currentRoom.toUpperCase()} rift in Edgefall${game ? ` after ${formatTime(game.elapsed)}` : ""}.${upgrades ? ` Build: ${upgrades}.` : ""}`,
    "Result copied",
  );
}

async function copyText(value: string, confirmation: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    showToast(confirmation);
  } catch {
    showToast("Clipboard permission was denied");
  }
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add("toast--visible");
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("toast--visible"), 2200);
}

function createRoomCode(): string {
  const nouns = ["ember", "ashen", "rift", "iron", "void", "cinder"];
  const noun = nouns[Math.floor(Math.random() * nouns.length)] ?? "rift";
  return `${noun}-${Math.random().toString(36).slice(2, 6)}`;
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}

function hashNumber(value: string): number {
  return [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0);
}

function easeOut(value: number): number {
  return 1 - (1 - Math.min(1, Math.max(0, value))) ** 3;
}

function openDialog(dialog: HTMLDialogElement): void {
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog: HTMLDialogElement): void {
  if (dialog.open) dialog.close();
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

function requireCanvasContext(target: HTMLCanvasElement): CanvasRenderingContext2D {
  const found = target.getContext("2d");
  if (!found) throw new Error("Canvas 2D is unavailable");
  return found;
}

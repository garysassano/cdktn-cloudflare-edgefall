import Phaser from "phaser";
import {
  type CompactSnapshot,
  type LoadoutSelection,
  OPERATOR_COPY,
  ORDNANCE_COPY,
  type OperatorId,
  type OrdnanceId,
  PRIMARY_WEAPONS,
  PROTOCOL_VERSION,
  type PrimaryWeaponId,
  REWARD_COPY,
  type RewardOffer,
  type RunResult,
  type ServerMessage,
  WEAPON_COPY,
} from "../game/protocol.js";
import { type ConnectionStatus, connectionText } from "../shared/session/connection.js";
import { browserConnectionPort } from "./connection-port.js";
import { RoomConnection } from "./network.js";
import { EdgefallScene, type PresentationSettings } from "./scene.js";

interface ProfileResponse {
  id: string;
  recentRuns: unknown[];
  unlocks: unknown[];
}

interface BoardRun {
  elapsedMs: number;
  id: string;
  score: number;
  summaryJson: string;
}

const gameScene = new EdgefallScene();
new Phaser.Game({
  antialias: false,
  backgroundColor: "#090808",
  input: { gamepad: true },
  parent: "game",
  pixelArt: true,
  render: { antialias: false, pixelArt: true, roundPixels: true },
  scale: { autoCenter: Phaser.Scale.CENTER_BOTH, mode: Phaser.Scale.FIT },
  scene: gameScene,
  type: Phaser.AUTO,
  width: 640,
  height: 360,
});

const landing = element<HTMLElement>("landing");
const lobby = element<HTMLElement>("lobby");
const reward = element<HTMLElement>("reward");
const results = element<HTMLElement>("results");
const boards = element<HTMLElement>("boards");
const settingsPanel = element<HTMLElement>("settings");
const hud = element<HTMLElement>("hud");
const combatHud = element<HTMLElement>("combatHud");
const partyHud = element<HTMLElement>("partyHud");
const connectionStatus = element<HTMLElement>("connectionStatus");
const playerNameInput = element<HTMLInputElement>("playerName");
const roomCodeInput = element<HTMLInputElement>("roomCode");
const readyButton = element<HTMLButtonElement>("readyButton");
const outfitSelect = element<HTMLSelectElement>("outfitSelect");
const weaponSelect = element<HTMLSelectElement>("weaponSelect");
const ordnanceSelect = element<HTMLSelectElement>("ordnanceSelect");
const toast = element<HTMLElement>("toast");

let currentLobby: Extract<ServerMessage, { type: "lobby" }> | undefined;
let currentOperator: OperatorId = "rook";
let currentResult: RunResult | undefined;
let currentRoom = "";
let toastTimer: number | undefined;
let settings = loadSettings();

const connection = new RoomConnection(
  {
    events: (events) => gameScene.playEvents(events),
    lobby: handleLobby,
    result: showResult,
    reward: showReward,
    snapshot: handleSnapshot,
    status: handleConnectionStatus,
    warning: showToast,
  },
  browserConnectionPort(),
  location.origin,
);
gameScene.onInput = (input) => connection.sendInput(input);
applySettings();

playerNameInput.value = localStorage.getItem("edgefall-name") ?? "";
roomCodeInput.value = new URL(location.href).searchParams.get("room") ?? createRoomCode();
updateLoadoutCopy();
void loadProfile();

element("enterButton").addEventListener("click", () => void enterRoom(false));
element("dailyButton").addEventListener("click", () => void enterRoom(true));
element("newRoomButton").addEventListener("click", () => {
  roomCodeInput.value = createRoomCode();
});
element("copyInviteButton").addEventListener("click", copyInvite);
element("leaveButton").addEventListener("click", leaveRoom);
readyButton.addEventListener("click", toggleReady);
element("rematchButton").addEventListener("click", () => {
  connection.send({ type: "rematch", v: PROTOCOL_VERSION });
  hide(results);
});
element("copyResultButton").addEventListener("click", copyResult);
element("boardsButton").addEventListener("click", () => void openBoards());
element("resultBoardsButton").addEventListener("click", () => void openBoards());
element("settingsButton").addEventListener("click", () => show(settingsPanel));
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close]")) {
  button.addEventListener("click", () => hide(element(button.dataset.close ?? "")));
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-operator]")) {
  button.addEventListener("click", () => {
    currentOperator = button.dataset.operator === "vale" ? "vale" : "rook";
    syncOperatorButtons();
    updateLoadoutCopy();
    sendSelection();
  });
}
for (const select of [outfitSelect, weaponSelect, ordnanceSelect]) {
  select.addEventListener("change", () => {
    updateLoadoutCopy();
    sendSelection();
  });
}
for (const select of [element("boardParty"), element("boardMode")]) {
  select.addEventListener("change", () => void loadBoard());
}
for (const id of [
  "volumeSetting",
  "shakeSetting",
  "flashSetting",
  "contrastSetting",
  "reduceMotionSetting",
]) {
  element<HTMLInputElement>(id).addEventListener("input", saveSettings);
}
window.addEventListener("keydown", (event) => {
  if (event.code !== "Escape") return;
  hide(boards);
  hide(settingsPanel);
});

const resultPath = location.pathname.match(/^\/runs\/([a-z0-9-]{8,80})$/i);
if (resultPath?.[1]) void loadResultPage(resultPath[1]);

async function enterRoom(daily: boolean): Promise<void> {
  const name = playerNameInput.value.trim() || "Operative";
  const room = daily ? createDailyRoom() : sanitizeRoom(roomCodeInput.value);
  if (room.length < 3) {
    showToast("Invite codes need at least three letters or numbers.");
    return;
  }
  localStorage.setItem("edgefall-name", name);
  currentRoom = room;
  roomCodeInput.value = room;
  const nextUrl = new URL(location.href);
  nextUrl.pathname = "/";
  nextUrl.searchParams.set("room", room);
  history.replaceState(null, "", nextUrl);
  hide(landing);
  try {
    await connection.connect(room, name);
  } catch (error) {
    show(landing);
    showToast(error instanceof Error ? error.message : "Could not enter the room.");
  }
}

function handleLobby(message: Extract<ServerMessage, { type: "lobby" }>): void {
  currentLobby = message;
  currentRoom = message.roomCode;
  element("lobbyCode").textContent = message.roomCode.toUpperCase();
  const local = message.players.find((player) => player.id === message.you);
  if (local) {
    currentOperator = local.selection.operator;
    outfitSelect.value = local.selection.outfit;
    weaponSelect.value = local.selection.primary;
    ordnanceSelect.value = local.selection.ordnance;
    syncOperatorButtons();
    updateLoadoutCopy();
    readyButton.textContent = local.ready ? "STAND DOWN" : "READY UP";
    readyButton.classList.toggle("primary", !local.ready);
    readyButton.classList.toggle("secondary", local.ready);
  }
  renderCrew(message);
  if (message.you && !message.locked) {
    hide(landing);
    hide(results);
    show(lobby);
    hideGameHud();
  }
}

function handleSnapshot(
  snapshot: CompactSnapshot,
  playerId: string,
  pending: readonly import("../game/protocol.js").InputFrame[],
): void {
  gameScene.applySnapshot(snapshot, playerId, pending);
  if (["combat", "boss"].includes(snapshot.phase)) {
    hide(landing);
    hide(lobby);
    hide(reward);
    hide(results);
    showGameHud();
  }
  updateHud(snapshot, playerId);
}

function showReward(offer: RewardOffer): void {
  const cards = element("rewardCards");
  cards.replaceChildren();
  for (const choice of offer.choices) {
    const copy = REWARD_COPY[choice];
    const button = document.createElement("button");
    button.type = "button";
    button.className = "reward-card";
    const name = document.createElement("b");
    name.textContent = copy.name;
    const description = document.createElement("span");
    description.textContent = copy.description;
    button.append(name, description);
    button.addEventListener("click", () => {
      connection.send({ choice, type: "upgrade-choice", v: PROTOCOL_VERSION });
      hide(reward);
    });
    cards.append(button);
  }
  show(reward);
}

function showResult(result: RunResult): void {
  currentResult = result;
  hide(reward);
  hideGameHud();
  element("resultEyebrow").textContent =
    result.result === "victory" ? "KILNHEART SHUT DOWN" : "THE RAIL LINE COLLAPSED";
  element("resultTitle").textContent = result.result === "victory" ? "RUN COMPLETE" : "CREW LOST";
  element("resultScore").textContent = result.score.toString().padStart(6, "0");
  element("resultTime").textContent = formatTime(result.elapsed);
  renderResultParty(result);
  show(results);
}

function updateHud(snapshot: CompactSnapshot, playerId: string): void {
  const local = snapshot.players.find((player) => player.id === playerId);
  element("phaseLabel").textContent = snapshot.module.name.toUpperCase();
  element("objectiveLabel").textContent = objective(snapshot);
  element("scoreLabel").textContent = snapshot.score.toString().padStart(6, "0");
  const boss = snapshot.enemies.find((enemy) => enemy.kind === "kilnheart");
  const bossHud = element<HTMLElement>("bossHud");
  bossHud.hidden = !boss;
  if (boss) {
    element("bossPhase").textContent = `PHASE ${roman(boss.bossPhase)}`;
    element<HTMLElement>("bossHealth").style.width =
      `${Math.max(0, (boss.hp / boss.maxHp) * 100)}%`;
    const broken = snapshot.bossComponents.filter((component) => component.broken).length;
    element("bossComponents").textContent =
      `FEEDS ${broken}/3 · ${boss.mode === "vent" ? "CORE EXPOSED" : "BREAK COMPONENTS"}`;
  }
  if (local) {
    const weapon = WEAPON_COPY[local.weapon.id];
    element("weaponName").textContent = weapon.name.toUpperCase();
    element("ammoLabel").textContent =
      local.weapon.id === "beam"
        ? `HEAT ${Math.round(local.weapon.heat)}%`
        : `${local.weapon.ammo} / ${local.weapon.reserve}`;
    element<HTMLElement>("weaponMeter").style.width = `${
      local.weapon.id === "beam"
        ? 100 - local.weapon.heat
        : (local.weapon.ammo / WEAPON_COPY[local.weapon.id].magazine) * 100
    }%`;
    element("abilityLabel").textContent =
      local.selection.operator === "rook"
        ? `BULWARK ${cooldown(local.abilityCooldown)}`
        : `RIFT STEP ${cooldown(local.abilityCooldown)}`;
    element("ordnanceLabel").textContent =
      `${ORDNANCE_COPY[local.selection.ordnance].name.toUpperCase()} ×${local.ordnanceRemaining}`;
  }
  renderPartyHud(snapshot, playerId);
}

function renderCrew(message: Extract<ServerMessage, { type: "lobby" }>): void {
  const crew = element("crewList");
  crew.replaceChildren();
  for (let slot = 0; slot < 4; slot += 1) {
    const player = message.players.find((candidate) => candidate.slot === slot);
    const item = document.createElement("div");
    item.className = `crew-slot${player?.ready ? " crew-slot--ready" : ""}`;
    item.style.setProperty(
      "--slot-color",
      ["#ff6a2f", "#72e6c4", "#ffd166", "#a98cff"][slot] ?? "#655",
    );
    const name = document.createElement("b");
    name.textContent = player
      ? `${player.name}${player.id === message.you ? " · YOU" : ""}`
      : "OPEN SLOT";
    const loadout = document.createElement("span");
    loadout.textContent = player
      ? `${OPERATOR_COPY[player.selection.operator].name} · ${WEAPON_COPY[player.selection.primary].name}`
      : "Invite only";
    const state = document.createElement("small");
    state.textContent = player
      ? player.connected
        ? player.ready
          ? "READY"
          : "CHOOSING LOADOUT"
        : "SLOT RESERVED"
      : "WAITING";
    item.append(name, loadout, state);
    crew.append(item);
  }
}

function renderPartyHud(snapshot: CompactSnapshot, playerId: string): void {
  partyHud.replaceChildren();
  for (const player of snapshot.players) {
    const member = document.createElement("div");
    member.className = `party-member${player.downed ? " party-member--down" : ""}`;
    member.style.setProperty("--member-color", player.color);
    const name = document.createElement("b");
    name.textContent = `${player.name}${player.id === playerId ? " · YOU" : ""}`;
    const state = document.createElement("span");
    state.textContent = player.downed
      ? `DOWN ${Math.ceil(player.downedRemaining)}s`
      : player.reentryRemaining > 0
        ? `RE-ENTRY ${player.reentryRemaining.toFixed(1)}s`
        : `${Math.ceil(player.hp)} HP`;
    const meter = document.createElement("div");
    meter.className = "meter";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(0, (player.hp / player.maxHp) * 100)}%`;
    meter.append(fill);
    member.append(name, state, meter);
    partyHud.append(member);
  }
}

function renderResultParty(result: RunResult): void {
  const party = element("resultParty");
  party.replaceChildren();
  for (const player of result.party) {
    const item = document.createElement("div");
    item.className = "result-member";
    const name = document.createElement("b");
    name.textContent = player.name;
    const loadout = document.createElement("span");
    loadout.textContent = `${OPERATOR_COPY[player.loadout.operator].name} · ${WEAPON_COPY[player.loadout.primary].name} · ${player.kills} kills · ${player.revives} revives · ${player.score} score`;
    const upgrades = document.createElement("span");
    upgrades.textContent =
      [...player.mutations, ...player.relics]
        .map((upgrade) => REWARD_COPY[upgrade].name)
        .join(" · ") || "No upgrades recorded";
    item.append(name, loadout, upgrades);
    party.append(item);
  }
}

function sendSelection(): void {
  if (!currentLobby?.you) return;
  connection.send({ selection: currentSelection(), type: "selection", v: PROTOCOL_VERSION });
}

function currentSelection(): LoadoutSelection {
  const primary = PRIMARY_WEAPONS.includes(weaponSelect.value as PrimaryWeaponId)
    ? (weaponSelect.value as PrimaryWeaponId)
    : "carbine";
  return {
    operator: currentOperator,
    ordnance: ordnanceSelect.value === "arc-mine" ? "arc-mine" : "cinder-bomb",
    outfit: outfitSelect.value === "foundry" ? "foundry" : "field",
    primary,
  };
}

function toggleReady(): void {
  const local = currentLobby?.players.find((player) => player.id === currentLobby?.you);
  if (!local) return;
  connection.send({ ready: !local.ready, type: "ready", v: PROTOCOL_VERSION });
}

function updateLoadoutCopy(): void {
  const operator = OPERATOR_COPY[currentOperator];
  element("operatorCopy").textContent = `${operator.passive} ${operator.ability}`;
  const weapon = weaponSelect.value as PrimaryWeaponId;
  element("weaponCopy").textContent = WEAPON_COPY[weapon]?.description ?? "";
  const ordnance = ordnanceSelect.value as OrdnanceId;
  element("ordnanceCopy").textContent = ORDNANCE_COPY[ordnance]?.description ?? "";
}

function syncOperatorButtons(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-operator]")) {
    button.classList.toggle("operator-card--selected", button.dataset.operator === currentOperator);
  }
}

function handleConnectionStatus(status: ConnectionStatus): void {
  gameScene.setConnectionActive(status.phase === "connected");
  connectionStatus.hidden = status.phase === "connected" || status.phase === "idle";
  connectionStatus.textContent = connectionText(status);
  if (status.phase === "stopped") {
    hide(lobby);
    hideGameHud();
    show(landing);
    showToast(connectionText(status));
  }
}

function leaveRoom(): void {
  connection.leave();
  currentLobby = undefined;
  hide(lobby);
  hideGameHud();
  show(landing);
}

async function loadProfile(): Promise<void> {
  try {
    const response = await fetch("/api/profile", { credentials: "same-origin" });
    if (!response.ok) throw new Error("profile request failed");
    const profile = (await response.json()) as ProfileResponse;
    element("profileLabel").textContent =
      `LOCAL PROFILE ${profile.id.slice(0, 8).toUpperCase()} · ${profile.recentRuns.length} RECENT RUNS`;
  } catch {
    element("profileLabel").textContent = "LOCAL PROFILE UNAVAILABLE";
  }
}

async function loadResultPage(runId: string): Promise<void> {
  hide(landing);
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    if (!response.ok) throw new Error("Run record not found");
    const result = (await response.json()) as RunResult;
    showResult(result);
    element<HTMLButtonElement>("rematchButton").hidden = true;
  } catch (error) {
    show(landing);
    showToast(error instanceof Error ? error.message : "Could not load that run.");
  }
}

async function openBoards(): Promise<void> {
  show(boards);
  await loadBoard();
}

async function loadBoard(): Promise<void> {
  const party = element<HTMLSelectElement>("boardParty").value;
  const mode = element<HTMLSelectElement>("boardMode").value;
  const rows = element("boardRows");
  rows.replaceChildren(makeTextRow("Loading records…"));
  try {
    const response = await fetch(`/api/leaderboards?party=${party}&mode=${mode}`);
    if (!response.ok) throw new Error("Leaderboard unavailable");
    const body = (await response.json()) as { runs: BoardRun[] };
    rows.replaceChildren();
    if (body.runs.length === 0) rows.append(makeTextRow("No completed runs on this board yet."));
    for (const run of body.runs) {
      let crew = "Unknown crew";
      try {
        const summary = JSON.parse(run.summaryJson) as RunResult;
        crew = summary.party.map((player) => player.name).join(" + ");
      } catch {
        // The run link remains usable even if legacy summary copy is unavailable.
      }
      const row = document.createElement("li");
      const link = document.createElement("a");
      link.href = `/runs/${encodeURIComponent(run.id)}`;
      link.textContent = crew;
      const score = document.createElement("span");
      score.textContent = run.score.toString().padStart(6, "0");
      const time = document.createElement("span");
      time.textContent = formatTime(run.elapsedMs / 1_000);
      row.append(link, score, time);
      rows.append(row);
    }
  } catch (error) {
    rows.replaceChildren(
      makeTextRow(error instanceof Error ? error.message : "Leaderboard unavailable"),
    );
  }
}

async function copyInvite(): Promise<void> {
  await copyText(`${location.origin}/?room=${encodeURIComponent(currentRoom)}`);
  showToast("Private invite link copied.");
}

async function copyResult(): Promise<void> {
  if (!currentResult) return;
  await copyText(`${location.origin}/runs/${encodeURIComponent(currentResult.runId)}`);
  showToast("Usable HTTPS result link copied.");
}

function saveSettings(): void {
  settings = {
    contrast: element<HTMLInputElement>("contrastSetting").checked,
    flashes: element<HTMLInputElement>("flashSetting").checked,
    reduceMotion: element<HTMLInputElement>("reduceMotionSetting").checked,
    shake: element<HTMLInputElement>("shakeSetting").checked,
    volume: Number(element<HTMLInputElement>("volumeSetting").value),
  };
  localStorage.setItem("edgefall-settings-v1", JSON.stringify(settings));
  applySettings();
}

function loadSettings(): PresentationSettings {
  try {
    const stored = JSON.parse(
      localStorage.getItem("edgefall-settings-v1") ?? "null",
    ) as Partial<PresentationSettings> | null;
    return {
      contrast: stored?.contrast ?? false,
      flashes: stored?.flashes ?? true,
      reduceMotion:
        stored?.reduceMotion ?? window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      shake: stored?.shake ?? true,
      volume: stored?.volume ?? 0.7,
    };
  } catch {
    return { contrast: false, flashes: true, reduceMotion: false, shake: true, volume: 0.7 };
  }
}

function applySettings(): void {
  element<HTMLInputElement>("contrastSetting").checked = settings.contrast;
  element<HTMLInputElement>("flashSetting").checked = settings.flashes;
  element<HTMLInputElement>("reduceMotionSetting").checked = settings.reduceMotion;
  element<HTMLInputElement>("shakeSetting").checked = settings.shake;
  element<HTMLInputElement>("volumeSetting").value = String(settings.volume);
  document.body.classList.toggle("high-contrast", settings.contrast);
  document.body.classList.toggle("reduce-motion", settings.reduceMotion);
  gameScene.setPresentationSettings(settings);
}

function showGameHud(): void {
  hud.hidden = false;
  combatHud.hidden = false;
  partyHud.hidden = false;
}

function hideGameHud(): void {
  hud.hidden = true;
  combatHud.hidden = true;
  partyHud.hidden = true;
}

function objective(snapshot: CompactSnapshot): string {
  if (snapshot.phase === "boss") return "Break the three feeds, then fire during the vent cycle";
  if (snapshot.module.kind === "freight-lift")
    return `Hold the moving lift · ${Math.max(0, 105 - Math.floor(snapshot.stageElapsed))}s`;
  if (snapshot.module.kind === "fall") return "Keep moving—the gantries are collapsing";
  return snapshot.enemies.length > 0
    ? `${snapshot.enemies.length} hostiles block the line`
    : "Advance to the module gate";
}

function cooldown(value: number): string {
  return value > 0 ? `${value.toFixed(1)}s` : "READY";
}

function roman(value: number): string {
  return ["—", "I", "II", "III"][value] ?? "I";
}

function createRoomCode(): string {
  const words = ["cinder", "gantry", "brass", "freight", "kiln", "ember", "rivet", "slag"];
  const first = words[Math.floor(Math.random() * words.length)] ?? "cinder";
  const second = words[Math.floor(Math.random() * words.length)] ?? "rail";
  return `${first}-${second}-${Math.floor(100 + Math.random() * 900)}`;
}

function createDailyRoom(): string {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? Date.now();
  return `daily-${date}-${random.toString(36).slice(0, 5).padStart(5, "0")}`;
}

function sanitizeRoom(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "")
    .slice(0, 24);
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add("toast--visible");
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("toast--visible"), 2_600);
}

function makeTextRow(copy: string): HTMLLIElement {
  const row = document.createElement("li");
  row.textContent = copy;
  return row;
}

function show(target: HTMLElement): void {
  target.hidden = false;
}

function hide(target: HTMLElement): void {
  target.hidden = true;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing interface element #${id}`);
  return found as T;
}

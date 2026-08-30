import type {
  DestructibleKind,
  EnemyKind,
  HazardKind,
  ModuleKind,
  RunModuleState,
} from "./protocol.js";

export interface PlatformTemplate {
  h: number;
  id: string;
  oneWay?: boolean;
  w: number;
  x: number;
  y: number;
}

export interface HazardTemplate {
  h: number;
  id: string;
  kind: HazardKind;
  w: number;
  x: number;
  y: number;
}

export interface DestructibleTemplate {
  h: number;
  hp: number;
  id: string;
  kind: DestructibleKind;
  reward?: "ammo" | "ordnance" | "score";
  w: number;
  x: number;
  y: number;
}

export interface EnemyTemplate {
  kind: EnemyKind;
  x: number;
  y: number;
}

export interface ModuleTemplate {
  destructibles: DestructibleTemplate[];
  durationTarget: number;
  enemies: EnemyTemplate[];
  hazards: HazardTemplate[];
  id: string;
  kind: ModuleKind;
  length: number;
  name: string;
  platforms: PlatformTemplate[];
}

const ENTRY_MODULES: readonly ModuleTemplate[] = [
  {
    destructibles: [
      { h: 30, hp: 45, id: "inlet-crate", kind: "crate", reward: "ammo", w: 34, x: 434, y: 298 },
      { h: 34, hp: 30, id: "inlet-barrel", kind: "barrel", reward: "score", w: 24, x: 812, y: 294 },
    ],
    durationTarget: 150,
    enemies: [
      { kind: "rifleman", x: 500, y: 286 },
      { kind: "rusher", x: 650, y: 286 },
      { kind: "drone", x: 820, y: 165 },
      { kind: "shieldbearer", x: 985, y: 286 },
    ],
    hazards: [{ h: 18, id: "inlet-molten", kind: "molten", w: 130, x: 685, y: 326 }],
    id: "molten-inlet",
    kind: "approach",
    length: 1180,
    name: "Molten Inlet",
    platforms: [
      { h: 32, id: "inlet-floor-a", w: 680, x: 0, y: 328 },
      { h: 32, id: "inlet-floor-b", w: 365, x: 815, y: 328 },
      { h: 14, id: "inlet-catwalk-a", oneWay: true, w: 210, x: 260, y: 238 },
      { h: 14, id: "inlet-catwalk-b", oneWay: true, w: 220, x: 790, y: 210 },
    ],
  },
  {
    destructibles: [
      {
        h: 30,
        hp: 45,
        id: "chain-crate",
        kind: "crate",
        reward: "ordnance",
        w: 34,
        x: 325,
        y: 298,
      },
      { h: 34, hp: 30, id: "chain-barrel", kind: "barrel", reward: "score", w: 24, x: 905, y: 294 },
    ],
    durationTarget: 150,
    enemies: [
      { kind: "rusher", x: 420, y: 286 },
      { kind: "grenadier", x: 625, y: 195 },
      { kind: "rifleman", x: 790, y: 286 },
      { kind: "drone", x: 970, y: 145 },
    ],
    hazards: [{ h: 54, id: "chain-steam", kind: "steam", w: 70, x: 725, y: 274 }],
    id: "chainworks",
    kind: "foundry",
    length: 1180,
    name: "Chainworks",
    platforms: [
      { h: 32, id: "chain-floor", w: 1180, x: 0, y: 328 },
      { h: 14, id: "chain-hook-a", oneWay: true, w: 180, x: 210, y: 230 },
      { h: 14, id: "chain-hook-b", oneWay: true, w: 165, x: 535, y: 204 },
      { h: 14, id: "chain-hook-c", oneWay: true, w: 190, x: 845, y: 240 },
    ],
  },
  {
    destructibles: [
      {
        h: 34,
        hp: 30,
        id: "gallery-barrel-a",
        kind: "barrel",
        reward: "score",
        w: 24,
        x: 520,
        y: 294,
      },
      {
        h: 34,
        hp: 30,
        id: "gallery-barrel-b",
        kind: "barrel",
        reward: "ammo",
        w: 24,
        x: 550,
        y: 294,
      },
    ],
    durationTarget: 150,
    enemies: [
      { kind: "shieldbearer", x: 430, y: 286 },
      { kind: "rifleman", x: 640, y: 198 },
      { kind: "grenadier", x: 815, y: 286 },
      { kind: "slag-warden", x: 1010, y: 278 },
    ],
    hazards: [
      { h: 18, id: "gallery-molten-a", kind: "molten", w: 90, x: 280, y: 326 },
      { h: 18, id: "gallery-molten-b", kind: "molten", w: 100, x: 900, y: 326 },
    ],
    id: "crucible-galleries",
    kind: "foundry",
    length: 1180,
    name: "Crucible Galleries",
    platforms: [
      { h: 32, id: "gallery-floor-a", w: 280, x: 0, y: 328 },
      { h: 32, id: "gallery-floor-b", w: 530, x: 370, y: 328 },
      { h: 32, id: "gallery-floor-c", w: 180, x: 1000, y: 328 },
      { h: 14, id: "gallery-bridge-a", oneWay: true, w: 240, x: 160, y: 218 },
      { h: 14, id: "gallery-bridge-b", oneWay: true, w: 250, x: 610, y: 220 },
    ],
  },
];

const FREIGHT_LIFT: ModuleTemplate = {
  destructibles: [
    { h: 30, hp: 45, id: "lift-crate", kind: "crate", reward: "ammo", w: 34, x: 180, y: 246 },
  ],
  durationTarget: 120,
  enemies: [
    { kind: "rifleman", x: 500, y: 238 },
    { kind: "rusher", x: 620, y: 238 },
    { kind: "drone", x: 420, y: 130 },
    { kind: "grenadier", x: 700, y: 238 },
    { kind: "slag-warden", x: 760, y: 238 },
  ],
  hazards: [],
  id: "freight-lift",
  kind: "freight-lift",
  length: 820,
  name: "Furnace Freight Lift",
  platforms: [
    { h: 26, id: "lift-platform", w: 650, x: 85, y: 278 },
    { h: 12, id: "lift-left", oneWay: true, w: 120, x: 25, y: 205 },
    { h: 12, id: "lift-right", oneWay: true, w: 120, x: 675, y: 205 },
  ],
};

const FALL_EVENT: ModuleTemplate = {
  destructibles: [],
  durationTarget: 90,
  enemies: [
    { kind: "drone", x: 370, y: 125 },
    { kind: "drone", x: 570, y: 160 },
    { kind: "rusher", x: 740, y: 260 },
  ],
  hazards: [{ h: 38, id: "fall-void", kind: "fall-zone", w: 880, x: 0, y: 340 }],
  id: "the-fall",
  kind: "fall",
  length: 880,
  name: "The Fall",
  platforms: [
    { h: 18, id: "fall-gantry-a", oneWay: true, w: 180, x: 20, y: 302 },
    { h: 18, id: "fall-gantry-b", oneWay: true, w: 170, x: 225, y: 258 },
    { h: 18, id: "fall-gantry-c", oneWay: true, w: 155, x: 425, y: 212 },
    { h: 18, id: "fall-gantry-d", oneWay: true, w: 160, x: 610, y: 270 },
    { h: 18, id: "fall-gantry-e", oneWay: true, w: 90, x: 790, y: 320 },
  ],
};

const KILNHEART: ModuleTemplate = {
  destructibles: [
    { h: 18, hp: 80, id: "boss-platform-left", kind: "boss-platform", w: 145, x: 130, y: 226 },
    { h: 18, hp: 80, id: "boss-platform-right", kind: "boss-platform", w: 145, x: 625, y: 226 },
  ],
  durationTarget: 180,
  enemies: [{ kind: "kilnheart", x: 450, y: 235 }],
  hazards: [
    { h: 18, id: "boss-molten-left", kind: "molten", w: 110, x: 0, y: 326 },
    { h: 18, id: "boss-molten-right", kind: "molten", w: 110, x: 790, y: 326 },
  ],
  id: "kilnheart-engine",
  kind: "kilnheart",
  length: 900,
  name: "Kilnheart Engine",
  platforms: [
    { h: 32, id: "boss-floor", w: 680, x: 110, y: 328 },
    { h: 14, id: "boss-catwalk", oneWay: true, w: 210, x: 345, y: 178 },
    { h: 18, id: "boss-platform-left", oneWay: true, w: 145, x: 130, y: 226 },
    { h: 18, id: "boss-platform-right", oneWay: true, w: 145, x: 625, y: 226 },
  ],
};

export function selectRunModules(random: () => number): ModuleTemplate[] {
  const pool = [...ENTRY_MODULES];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [pool[index], pool[swap]] = [pool[swap] as ModuleTemplate, pool[index] as ModuleTemplate];
  }
  return [
    pool[0] as ModuleTemplate,
    pool[1] as ModuleTemplate,
    FREIGHT_LIFT,
    FALL_EVENT,
    KILNHEART,
  ];
}

export function describeRunModules(templates: readonly ModuleTemplate[]): RunModuleState[] {
  let cursor = 0;
  return templates.map((template) => {
    const module: RunModuleState = {
      durationTarget: template.durationTarget,
      endX: cursor + template.length,
      id: template.id,
      kind: template.kind,
      name: template.name,
      startX: cursor,
    };
    cursor += template.length;
    return module;
  });
}

export function getModuleTemplate(id: string): ModuleTemplate {
  const template = [...ENTRY_MODULES, FREIGHT_LIFT, FALL_EVENT, KILNHEART].find(
    (candidate) => candidate.id === id,
  );
  if (!template) throw new Error(`Unknown hand-authored module: ${id}`);
  return template;
}

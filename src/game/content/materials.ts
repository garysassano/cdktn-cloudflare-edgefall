import { integer } from "../core/numeric.js";
import type { SweepTarget } from "../physics/sweep.js";

export const ATTACK_MATERIALS = [
  "bullet",
  "explosive",
  "heat",
  "energy",
  "blade",
  "blunt",
] as const;
export type AttackMaterial = (typeof ATTACK_MATERIALS)[number];
export const SURFACE_MATERIAL_IDS = ["concrete", "timber", "armor-steel", "open-grating"] as const;
export type SurfaceMaterialId = (typeof SURFACE_MATERIAL_IDS)[number];
export interface SurfaceMaterial {
  id: SurfaceMaterialId;
  /** Integer damage scale; zero is immunity. This never changes an attack's hit budget. */
  damageScale: Readonly<Record<AttackMaterial, number>>;
  /** Body movement and released grenade/rocket bodies still collide with physical solids. */
  blocks: Readonly<Record<AttackMaterial, boolean>>;
}

const opaque = {
  bullet: true,
  explosive: true,
  heat: true,
  energy: true,
  blade: true,
  blunt: true,
};
export const SURFACE_MATERIALS: readonly SurfaceMaterial[] = [
  {
    id: "concrete",
    damageScale: { bullet: 0, explosive: 0, heat: 0, energy: 0, blade: 0, blunt: 0 },
    blocks: { ...opaque },
  },
  {
    id: "timber",
    damageScale: { bullet: 1, explosive: 1, heat: 1, energy: 1, blade: 1, blunt: 1 },
    blocks: { ...opaque },
  },
  {
    id: "armor-steel",
    damageScale: { bullet: 0, explosive: 1, heat: 0, energy: 2, blade: 0, blunt: 0 },
    blocks: { ...opaque },
  },
  {
    id: "open-grating",
    damageScale: { bullet: 1, explosive: 1, heat: 0, energy: 1, blade: 0, blunt: 1 },
    blocks: {
      bullet: true,
      explosive: false,
      heat: false,
      energy: false,
      blade: true,
      blunt: true,
    },
  },
];

export interface MaterialSurface extends SweepTarget {
  /** Ordinary world solids are concrete. Authored exceptions bind a registered material. */
  materialId?: SurfaceMaterialId;
}
export function validateSurfaceMaterials(definitions: readonly SurfaceMaterial[]): void {
  if (definitions.length !== SURFACE_MATERIAL_IDS.length)
    throw new Error("Material roster mismatch");
  for (const [index, material] of definitions.entries()) {
    if (
      material.id !== SURFACE_MATERIAL_IDS[index] ||
      Object.keys(material).sort().join() !== "blocks,damageScale,id"
    )
      throw new Error("Unknown or malformed surface material");
    for (const table of [material.damageScale, material.blocks])
      if (Object.keys(table).sort().join() !== [...ATTACK_MATERIALS].sort().join())
        throw new Error("Incomplete material response table");
    for (const attack of ATTACK_MATERIALS) {
      integer(material.damageScale[attack], 0, 4, "material damage scale");
      if (typeof material.blocks[attack] !== "boolean")
        throw new Error("Invalid material blocking policy");
    }
  }
}
validateSurfaceMaterials(SURFACE_MATERIALS);

export function surfaceMaterial(id: SurfaceMaterialId): SurfaceMaterial {
  const material = SURFACE_MATERIALS.find((material) => material.id === id);
  if (!material) throw new Error("Unknown surface material");
  return material;
}
export function surfaceMaterialFor(target: { materialId?: SurfaceMaterialId }): SurfaceMaterial {
  return surfaceMaterial(target.materialId === undefined ? "concrete" : target.materialId);
}
export function materialBlocks(
  target: { materialId?: SurfaceMaterialId },
  attack: AttackMaterial,
): boolean {
  if (!ATTACK_MATERIALS.includes(attack)) throw new Error("Unknown attack material");
  return surfaceMaterialFor(target).blocks[attack];
}
export function materialDamage(
  damage: number,
  attack: AttackMaterial,
  materialId: SurfaceMaterialId,
): number {
  integer(damage, 0, 65535, "material incoming damage");
  if (!ATTACK_MATERIALS.includes(attack)) throw new Error("Unknown attack material");
  return Math.min(65535, damage * surfaceMaterial(materialId).damageScale[attack]);
}

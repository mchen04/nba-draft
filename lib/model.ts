import { z } from "zod";

export const slots = [
  "PG",
  "SG",
  "SF",
  "PF",
  "C",
  "G",
  "F",
  "UTIL",
  "BN",
] as const;
export type Slot = (typeof slots)[number];
export const statIds = {
  PTS: 0,
  BLK: 1,
  STL: 2,
  AST: 3,
  REB: 6,
  TO: 11,
  FGM: 13,
  FGA: 14,
  FTM: 15,
  FTA: 16,
  "3PM": 17,
  "3PA": 18,
  "FG%": 19,
  "FT%": 20,
  "3P%": 21,
  FGMISS: 23,
  FTMISS: 24,
  "3PMISS": 25,
  MIN: 40,
  GP: 42,
} as const;
export type Stat = keyof typeof statIds;
export const countingStats = Object.keys(statIds).filter(
  (key) => !key.endsWith("%"),
) as Stat[];
export const categoryStats: Stat[] = [
  "PTS",
  "REB",
  "AST",
  "STL",
  "BLK",
  "3PM",
  "FG%",
  "FT%",
  "TO",
  "3P%",
];
export type Player = {
  id: number;
  name: string;
  team: string;
  positions: Slot[];
  injury: string;
  totals: Record<Stat, number | null>;
  derived: Stat[];
  projected: boolean;
};
export type Catalog = {
  season: number;
  fetchedAt: string;
  players: Player[];
  projectedCount: number;
  missing: Record<string, number>;
  warning: string | null;
};

const counts = z.object(
  Object.fromEntries(
    slots.map((slot) => [slot, z.number().int().min(0).max(30)]),
  ) as Record<Slot, z.ZodNumber>,
);
const weights = z.partialRecord(
  z.enum(countingStats as [Stat, ...Stat[]]),
  z
    .number()
    .min(-100)
    .max(100)
    .refine(
      (value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-8,
      "Use at most three decimal places.",
    ),
);
export const settingsSchema = z
  .object({
    teamCount: z.number().int().min(2).max(20),
    order: z.array(z.number().int()).min(2).max(20),
    format: z.enum(["3rr", "snake"]),
    seconds: z.number().int().min(5).max(600),
    slots: counts,
    scoring: z.enum(["categories", "points"]),
    categories: z.array(z.enum(categoryStats as [Stat, ...Stat[]])).min(1),
    weights,
    fallback: z.enum(["PTS", "FP", ...categoryStats]),
    season: z.number().int().min(2020).max(2100),
  })
  .superRefine((value, context) => {
    const capacity = Object.values(value.slots).reduce(
      (total, count) => total + count,
      0,
    );
    if (capacity < 1 || capacity > 30)
      context.addIssue({
        code: "custom",
        message: "Roster size must be 1–30 slots.",
      });
    if (
      value.order.length !== value.teamCount ||
      new Set(value.order).size !== value.teamCount ||
      value.order.some((slot) => slot < 0 || slot >= value.teamCount)
    )
      context.addIssue({
        code: "custom",
        message: "Draft order must contain every team once.",
      });
    if (
      value.scoring === "points" &&
      !Object.values(value.weights).some((weight) => weight !== 0)
    )
      context.addIssue({
        code: "custom",
        message: "Points scoring needs a nonzero weight.",
      });
    if (value.scoring === "categories" && value.fallback === "FP")
      context.addIssue({
        code: "custom",
        message: "Categories need a category fallback.",
      });
  });
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  teamCount: 12,
  order: Array.from({ length: 12 }, (_, index) => index),
  format: "3rr",
  seconds: 60,
  slots: { PG: 1, SG: 1, SF: 1, PF: 1, C: 1, G: 1, F: 1, UTIL: 3, BN: 3 },
  scoring: "categories",
  categories: categoryStats.slice(0, 9),
  weights: { PTS: 1, REB: 1.2, AST: 1.5, STL: 3, BLK: 3, TO: -1 },
  fallback: "PTS",
  season: 2027,
};
export type Member = {
  name: string;
  slot: number | null;
  commissioner: boolean;
  sessions: string[];
  recovery: string;
  ready: boolean;
  queue: number[];
};
export type Pick = {
  index: number;
  slot: number;
  playerId: number;
  source: "manual" | "queue" | "ranking" | "commissioner";
  at: string;
  requestId: string | null;
};
export type Room = {
  id: string;
  name: string;
  settings: Settings;
  phase: "lobby" | "live" | "paused" | "complete";
  deadline: number | null;
  remaining: number | null;
  picks: Pick[];
  members: Member[];
  catalog: Catalog;
  ranking: number[];
  version: number;
  message: string | null;
};
export type View = Omit<Room, "members" | "catalog" | "ranking"> & {
  members: { name: string; slot: number | null; ready: boolean }[];
  me: { slot: number | null; commissioner: boolean; ready: boolean } | null;
  queue: number[];
  catalog: Omit<Catalog, "players">;
  serverNow: number;
};

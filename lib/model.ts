import { z as zod } from "zod";

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
export type Source = {
  name: string;
  url: string;
  // Player count ESPN reports for the query, and entries actually received.
  reported: number | null;
  received: number;
};
// One shared, immutable player dataset version. Rooms store everything except `players`.
export type Catalog = {
  dataset: number;
  // sha256 of the pool; part of the cached URL, so a reissued id cannot serve stale players.
  digest?: string;
  season: number;
  mapping?: number;
  fetchedAt: string;
  checkedAt?: string;
  source?: Source;
  players: Player[];
  projectedCount: number;
  missing: Record<string, number>;
  warning: string | null;
};
export type CatalogMeta = Omit<Catalog, "players">;

const counts = zod.object(
  Object.fromEntries(
    slots.map((slot) => [
      slot,
      zod
        .number()
        .int()
        .min(0, `${slot} slots must be 0–30.`)
        .max(30, `${slot} slots must be 0–30.`),
    ]),
  ) as Record<Slot, zod.ZodNumber>,
);
const weights = zod.partialRecord(
  zod.enum(countingStats as [Stat, ...Stat[]]),
  zod
    .number()
    .min(-100, "Points per stat must be -100 to 100.")
    .max(100, "Points per stat must be -100 to 100.")
    .refine(
      (value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-8,
      "Use at most three decimal places.",
    ),
);
export const settingsSchema = zod
  .object({
    teamCount: zod
      .number()
      .int("Teams must be a whole number.")
      .min(2, "Teams must be 2–20.")
      .max(20, "Teams must be 2–20."),
    order: zod
      .array(zod.number().int("Draft order must contain every team once."))
      .min(2, "Draft order must contain every team once.")
      .max(20, "Draft order must contain every team once."),
    format: zod.enum(["3rr", "snake"]),
    seconds: zod
      .number()
      .int("Seconds per pick must be a whole number.")
      .min(5, "Seconds per pick must be 5–600.")
      .max(600, "Seconds per pick must be 5–600."),
    slots: counts,
    scoring: zod.enum(["categories", "points"]),
    categories: zod.array(zod.enum(categoryStats as [Stat, ...Stat[]])).min(1),
    weights,
    fallback: zod.enum(["PTS", "FP", ...categoryStats]),
    season: zod.number().int().min(2020).max(2100),
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
export type Settings = zod.infer<typeof settingsSchema>;
// ESPN H2H Points league defaults, read 2026-10-01 from ESPN's league-defaults
// settings feed (leaguedefaults/2, season 2027) and ESPN's points-scoring article.
// ESPN also adds one IR slot; IR is not a draft round, so the app omits it.
export const espnPointsDefaults = {
  teamCount: 10,
  format: "snake",
  seconds: 90,
  slots: { PG: 1, SG: 1, SF: 1, PF: 1, C: 1, G: 1, F: 1, UTIL: 3, BN: 3 },
  weights: {
    PTS: 1,
    "3PM": 1,
    FGA: -1,
    FGM: 2,
    FTA: -1,
    FTM: 1,
    REB: 1,
    AST: 2,
    STL: 4,
    BLK: 4,
    TO: -2,
  },
} satisfies Partial<Settings>;
// ESPN's season id is the year the season ends; its feed switched to 2027 before October 2026.
export function currentSeason(date = new Date()) {
  return date.getUTCFullYear() + (date.getUTCMonth() >= 6 ? 1 : 0);
}
// Every value is ESPN's points default except the draft format: 3RR is this app's default.
export const defaultSettings: Settings = {
  ...espnPointsDefaults,
  order: Array.from(
    { length: espnPointsDefaults.teamCount },
    (_, index) => index,
  ),
  format: "3rr",
  scoring: "points",
  categories: categoryStats.slice(0, 9),
  fallback: "FP",
  season: currentSeason(),
};
export type Member = {
  name: string;
  slot: number | null;
  commissioner: boolean;
  sessions: string[];
  recovery: string;
  ready: boolean;
  queue: number[];
  activeAt?: number;
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
  activeAt?: number;
};
export type View = Omit<Room, "members" | "catalog" | "ranking"> & {
  members: {
    name: string;
    slot: number | null;
    ready: boolean;
    commissioner: boolean;
  }[];
  commissionerIdle: boolean;
  me: { slot: number | null; commissioner: boolean; ready: boolean } | null;
  viewer: number;
  queue: number[];
  catalog: CatalogMeta;
  serverNow: number;
};
// A poll reply when the room still has the version the tab shows.
export type Unchanged = {
  unchanged: true;
  version: number;
  serverNow: number;
  commissionerIdle: boolean;
};

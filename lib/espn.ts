import { z as zod } from "zod";
import { Catalog, Player, Slot, Stat, statIds } from "./model";
import { database } from "./db";

const teamNames = [
  "FA",
  "ATL",
  "BOS",
  "NOP",
  "CHI",
  "CLE",
  "DAL",
  "DEN",
  "DET",
  "GSW",
  "HOU",
  "IND",
  "LAC",
  "LAL",
  "MIA",
  "MIL",
  "MIN",
  "BKN",
  "NYK",
  "ORL",
  "PHI",
  "PHX",
  "POR",
  "SAC",
  "SAS",
  "OKC",
  "UTA",
  "WAS",
  "TOR",
  "MEM",
  "CHA",
];
const slotNames: Record<number, Slot> = {
  0: "PG",
  1: "SG",
  2: "SF",
  3: "PF",
  4: "C",
  5: "G",
  6: "F",
  11: "UTIL",
  12: "BN",
};
const sourcePlayer = zod.object({
  id: zod.number().int().positive(),
  fullName: zod.string().min(1),
  proTeamId: zod.number().int(),
  eligibleSlots: zod.array(zod.number().int()),
  injuryStatus: zod.string().optional(),
  stats: zod
    .array(
      zod.object({
        seasonId: zod.number(),
        statSourceId: zod.number(),
        statSplitTypeId: zod.number(),
        scoringPeriodId: zod.number(),
        stats: zod.record(zod.string(), zod.number()),
      }),
    )
    .optional(),
});
const responseSchema = zod.object({
  players: zod.array(zod.object({ player: sourcePlayer })).min(1),
});

export function normalizeCatalog(
  body: unknown,
  season: number,
  fetchedAt = new Date().toISOString(),
): Catalog {
  const parsed = responseSchema.parse(body);
  const ids = new Set<number>();
  const players: Player[] = [];
  for (const { player } of parsed.players) {
    if (ids.has(player.id)) throw new Error("Duplicate source identity.");
    ids.add(player.id);
    const positions = player.eligibleSlots.flatMap((slot) =>
      slotNames[slot] ? [slotNames[slot]] : [],
    );
    if (!positions.length) continue;
    const projections =
      player.stats?.filter(
        (line) =>
          line.seasonId === season &&
          line.statSourceId === 1 &&
          line.statSplitTypeId === 0 &&
          line.scoringPeriodId === 0,
      ) ?? [];
    const projection = projections.length === 1 ? projections[0].stats : {};
    const totals = Object.fromEntries(
      Object.entries(statIds).map(([key, id]) => {
        const input = projection[id];
        return [
          key,
          typeof input === "number" &&
          Number.isFinite(input) &&
          input >= 0 &&
          (!key.endsWith("%") || input <= 1)
            ? input
            : null,
        ];
      }),
    ) as Record<Stat, number | null>;
    const derived: Stat[] = [];
    for (const [ratio, made, attempted] of [
      ["FG%", "FGM", "FGA"],
      ["FT%", "FTM", "FTA"],
      ["3P%", "3PM", "3PA"],
    ] as Stat[][]) {
      if (
        totals[ratio] === null &&
        totals[made] !== null &&
        totals[attempted] !== null &&
        totals[attempted]! > 0 &&
        totals[made]! <= totals[attempted]!
      ) {
        totals[ratio] = totals[made]! / totals[attempted]!;
        derived.push(ratio);
      }
    }
    for (const [missed, made, attempted] of [
      ["FGMISS", "FGM", "FGA"],
      ["FTMISS", "FTM", "FTA"],
      ["3PMISS", "3PM", "3PA"],
    ] as Stat[][]) {
      if (
        totals[missed] === null &&
        totals[made] !== null &&
        totals[attempted] !== null &&
        totals[made]! <= totals[attempted]!
      ) {
        totals[missed] = totals[attempted]! - totals[made]!;
        derived.push(missed);
      }
    }
    players.push({
      id: player.id,
      name: player.fullName,
      team: teamNames[player.proTeamId] ?? `Team ${player.proTeamId}`,
      positions,
      injury: player.injuryStatus ?? "UNKNOWN",
      totals,
      derived,
      projected: Object.values(totals).some((input) => input !== null),
    });
  }
  if (!players.length) throw new Error("No recognized eligible players.");
  return {
    season,
    fetchedAt,
    players,
    projectedCount: players.filter((player) => player.projected).length,
    missing: Object.fromEntries(
      Object.keys(statIds).map((stat) => [
        stat,
        players.filter((player) => player.totals[stat as Stat] === null).length,
      ]),
    ),
    warning:
      players.length < parsed.players.length
        ? `${parsed.players.length - players.length} entries have no supported draft position and are excluded.`
        : null,
  };
}

export async function fetchEspn(season: number): Promise<Catalog> {
  const response = await fetch(
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${season}/segments/0/leaguedefaults/1?view=kona_player_info`,
    {
      headers: {
        Accept: "application/json",
        "X-Fantasy-Filter": JSON.stringify({
          players: {
            limit: 1500,
            sortPercOwned: { sortPriority: 1, sortAsc: false },
            filterStatsForSourceIds: { value: [1] },
            filterStatsForSplitTypeIds: { value: [0] },
          },
        }),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) throw new Error("Projection source is unavailable.");
  const body = await response.json();
  const parsed = responseSchema.parse(body);
  const count = response.headers.get("x-fantasy-filter-player-count");
  if (
    (count && Number(count) > parsed.players.length) ||
    parsed.players.length >= 1500
  )
    throw new Error("Source pool may be truncated.");
  return normalizeCatalog(body, season);
}

export async function getCatalog(
  season: number,
  force = false,
): Promise<Catalog> {
  const client = await database().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO nba_draft.catalogs(season) VALUES($1) ON CONFLICT DO NOTHING",
      [season],
    );
    const result = await client.query(
      "SELECT * FROM nba_draft.catalogs WHERE season=$1 FOR UPDATE",
      [season],
    );
    const cached = result.rows[0];
    const snapshot = cached.snapshot as Catalog | null;
    const age = snapshot
      ? Date.now() - new Date(snapshot.fetchedAt).getTime()
      : Infinity;
    const sinceAttempt = cached.attempted_at
      ? Date.now() - new Date(cached.attempted_at).getTime()
      : Infinity;
    if (
      (snapshot && !force && age < 6 * 3600000) ||
      sinceAttempt < 15 * 60000
    ) {
      await client.query("COMMIT");
      if (!snapshot)
        throw new Error(
          "Projection source is unavailable. Try again after 15 minutes.",
        );
      return { ...snapshot, warning: cached.error ?? snapshot.warning };
    }
    try {
      const catalog = await fetchEspn(season);
      await client.query(
        "UPDATE nba_draft.catalogs SET snapshot=$2, attempted_at=now(), error=NULL WHERE season=$1",
        [season, JSON.stringify(catalog)],
      );
      await client.query("COMMIT");
      return catalog;
    } catch {
      const warning =
        "ESPN refresh failed. Cached projections remain unchanged. Try again after 15 minutes.";
      await client.query(
        "UPDATE nba_draft.catalogs SET attempted_at=now(), error=$2 WHERE season=$1",
        [season, warning],
      );
      await client.query("COMMIT");
      if (snapshot) return { ...snapshot, warning };
      throw new Error(
        "No cached player pool exists for this season. Try again after 15 minutes.",
      );
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

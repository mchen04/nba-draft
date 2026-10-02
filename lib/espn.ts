import { z as zod } from "zod";
import { Catalog, CatalogMeta, Player, Slot, Stat, statIds } from "./model";
import { begin, database } from "./db";
import { PoolClient } from "pg";

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

// ESPN omits zero-valued stats from a projection line. Restore those zeros only when
// the line's shooting and scoring totals reconcile with them; otherwise keep gaps missing.
export function sparse(stats: Record<string, number>): Record<string, number> {
  const games = stats[statIds.GP];
  if (!(games > 0)) return stats;
  const filled: Record<string, number> = { ...stats };
  for (const [key, id] of Object.entries(statIds))
    if (!key.endsWith("%") && filled[id] === undefined) filled[id] = 0;
  const stat = (key: Stat) => filled[statIds[key]];
  const reconciles =
    Math.abs(stat("PTS") - (2 * stat("FGM") + stat("3PM") + stat("FTM"))) <=
      1 &&
    (
      [
        ["FGA", "FGM", "FGMISS"],
        ["FTA", "FTM", "FTMISS"],
        ["3PA", "3PM", "3PMISS"],
      ] as Stat[][]
    ).every(
      ([attempted, made, missed]) =>
        Math.abs(stat(attempted) - stat(made) - stat(missed)) < 1,
    );
  return reconciles ? filled : stats;
}

// Bump when normalization changes so cached snapshots refresh from ESPN.
export const mappingVersion = 2;

const sourceName = "ESPN Fantasy Basketball projections";
const sourceUrl = (season: number) =>
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/fba/seasons/${season}/segments/0/leaguedefaults/1?view=kona_player_info`;

export function normalizeCatalog(
  body: unknown,
  season: number,
  fetchedAt = new Date().toISOString(),
  reported: number | null = null,
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
    const projection =
      projections.length === 1 ? sparse(projections[0].stats) : {};
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
    dataset: 0,
    season,
    mapping: mappingVersion,
    fetchedAt,
    source: {
      name: sourceName,
      url: sourceUrl(season),
      reported,
      received: parsed.players.length,
    },
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
  const response = await fetch(sourceUrl(season), {
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
  });
  if (!response.ok) throw new Error("Projection source is unavailable.");
  const body = await response.json();
  const parsed = responseSchema.parse(body);
  const count = response.headers.get("x-fantasy-filter-player-count");
  if (
    (count && Number(count) > parsed.players.length) ||
    parsed.players.length >= 1500
  )
    throw new Error("Source pool may be truncated.");
  return normalizeCatalog(
    body,
    season,
    undefined,
    count === null ? null : Number(count),
  );
}

// The shared pool is checked weekly. A failed check keeps the last good dataset.
export const refreshAge = 7 * 86400000;
export const retryDelay = 15 * 60000;

// Datasets never change after insert, so each server instance keeps recent ones.
const datasets = new Map<number, Catalog>();
function remember(catalog: Catalog) {
  datasets.delete(catalog.dataset);
  datasets.set(catalog.dataset, catalog);
  if (datasets.size > 4) datasets.delete(datasets.keys().next().value!);
}
// The full dataset as served to browsers; null when the id does not exist.
export async function datasetCatalog(id: number, client?: PoolClient) {
  const cached = datasets.get(id);
  if (cached) return cached;
  const result = await (client ?? database()).query(
    "SELECT digest, meta, players FROM nba_draft.datasets WHERE id=$1",
    [id],
  );
  if (!result.rows.length) return null;
  const catalog: Catalog = {
    ...result.rows[0].meta,
    dataset: id,
    digest: result.rows[0].digest,
    players: result.rows[0].players,
  };
  remember(catalog);
  return catalog;
}
export async function datasetPlayers(id: number, client?: PoolClient) {
  const catalog = await datasetCatalog(id, client);
  if (!catalog) throw new Error("Player dataset is missing.");
  return catalog.players;
}

// Returns the current shared dataset for a season, with players, refreshing it from ESPN
// when the last good check is a week old or `force` is set (at most once per 15 minutes).
export async function getCatalog(
  season: number,
  force = false,
  transaction?: PoolClient,
): Promise<Catalog> {
  if (transaction) {
    const catalog = await readCatalog(transaction, season, force);
    if (catalog instanceof Error) throw catalog;
    return catalog;
  }
  const client = await begin();
  try {
    const catalog = await readCatalog(client, season, force);
    await client.query("COMMIT");
    if (catalog instanceof Error) throw catalog;
    return catalog;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function readCatalog(
  client: PoolClient,
  season: number,
  force: boolean,
): Promise<Catalog | Error> {
  await client.query(
    "INSERT INTO nba_draft.catalogs(season) VALUES($1) ON CONFLICT DO NOTHING",
    [season],
  );
  const result = await client.query(
    "SELECT c.dataset_id, c.attempted_at, c.checked_at, c.error, d.digest, d.meta FROM nba_draft.catalogs c LEFT JOIN nba_draft.datasets d ON d.id = c.dataset_id WHERE c.season=$1 FOR UPDATE OF c",
    [season],
  );
  const cached = result.rows[0];
  const meta: CatalogMeta | null = cached.dataset_id
    ? {
        ...cached.meta,
        dataset: Number(cached.dataset_id),
        digest: cached.digest,
        checkedAt: cached.checked_at?.toISOString(),
      }
    : null;
  const age = cached.checked_at
    ? Date.now() - cached.checked_at.getTime()
    : Infinity;
  const sinceAttempt = cached.attempted_at
    ? Date.now() - cached.attempted_at.getTime()
    : Infinity;
  const current = meta?.mapping === mappingVersion;
  const withPlayers = async (catalog: CatalogMeta) => ({
    ...catalog,
    players: await datasetPlayers(catalog.dataset, client),
  });
  if (
    (meta && current && !force && age < refreshAge) ||
    sinceAttempt < retryDelay
  ) {
    if (!meta)
      return new Error(
        "Projection source is unavailable. Try again after 15 minutes.",
      );
    return withPlayers({ ...meta, warning: cached.error ?? meta.warning });
  }
  let fetched: Catalog;
  try {
    fetched = await fetchEspn(season);
  } catch {
    const warning =
      "ESPN refresh failed. Cached projections remain unchanged. Try again after 15 minutes.";
    await client.query(
      "UPDATE nba_draft.catalogs SET attempted_at=now(), error=$2 WHERE season=$1",
      [season, warning],
    );
    if (meta) return withPlayers({ ...meta, warning });
    return new Error(
      "No cached player pool exists for this season. Try again after 15 minutes.",
    );
  }
  const { players: pool, dataset: _dataset, ...fresh } = fetched;
  // An unchanged pool keeps its dataset and first retrieval time.
  const stored = await client.query(
    `WITH inserted AS (
       INSERT INTO nba_draft.datasets(season, digest, meta, players)
       VALUES($1, nba_draft.dataset_digest($1, $2, $4::jsonb), $3, $4)
       ON CONFLICT (digest) DO NOTHING RETURNING id, digest, meta)
     SELECT id, digest, meta FROM inserted
     UNION ALL SELECT id, digest, meta FROM nba_draft.datasets WHERE digest = nba_draft.dataset_digest($1, $2, $4::jsonb)
     LIMIT 1`,
    [season, fresh.mapping, JSON.stringify(fresh), JSON.stringify(pool)],
  );
  const id = Number(stored.rows[0].id);
  const checked = await client.query(
    "UPDATE nba_draft.catalogs SET dataset_id=$2, attempted_at=now(), checked_at=clock_timestamp(), error=NULL WHERE season=$1 RETURNING checked_at",
    [season, id],
  );
  const catalog: Catalog = {
    ...stored.rows[0].meta,
    dataset: id,
    digest: stored.rows[0].digest,
    players: pool,
  };
  remember(catalog);
  return { ...catalog, checkedAt: checked.rows[0].checked_at.toISOString() };
}

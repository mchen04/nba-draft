import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  Player,
  Slot,
  currentSeason,
  defaultSettings,
  espnPointsDefaults,
  settingsSchema,
  statIds,
} from "../lib/model";
import {
  matchRoster,
  pickOrder,
  rankPlayers,
  rosterProjection,
  value,
} from "../lib/rules";
import { normalizeCatalog } from "../lib/espn";

const player = (
  id: number,
  positions: Slot[],
  totals: Partial<Player["totals"]> = {},
): Player => ({
  id,
  name: `Player ${id}`,
  positions,
  totals: {
    ...Object.fromEntries(Object.keys(statIds).map((stat) => [stat, null])),
    ...totals,
  } as Player["totals"],
  derived: [],
  team: "FA",
  projected: false,
  injury: "ACTIVE",
});
test("3RR reverses round three, then alternates; snake does not", () => {
  const base = {
    ...defaultSettings,
    teamCount: 4,
    order: [0, 1, 2, 3],
    slots: {
      ...defaultSettings.slots,
      PG: 0,
      SG: 0,
      SF: 0,
      PF: 0,
      C: 0,
      G: 0,
      F: 0,
      UTIL: 6,
      BN: 0,
    },
  };
  assert.deepEqual(
    pickOrder(base),
    [0, 1, 2, 3, 3, 2, 1, 0, 3, 2, 1, 0, 0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3],
  );
  assert.deepEqual(
    pickOrder({ ...base, format: "snake" }),
    [0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 2, 3, 3, 2, 1, 0],
  );
  for (let count = 2; count <= 20; count++) {
    for (let rounds = 1; rounds <= 30; rounds++) {
      for (const format of ["3rr", "snake"] as const) {
        const order = Array.from(
          { length: count },
          (_, index) => count - index - 1,
        );
        const configured = {
          ...base,
          teamCount: count,
          order,
          format,
          slots: { ...base.slots, UTIL: rounds },
        };
        const result = pickOrder(configured);
        assert.equal(result.length, count * rounds);
        for (let round = 1; round <= rounds; round++) {
          const forward =
            format === "snake"
              ? round % 2 === 1
              : round === 1 || (round > 3 && round % 2 === 0);
          assert.deepEqual(
            result.slice((round - 1) * count, round * count),
            forward ? order : [...order].reverse(),
          );
        }
      }
    }
  }
});
test("matching rearranges earlier flexible players and rejects impossible rosters", () => {
  assert.deepEqual(
    matchRoster([player(1, ["PG", "G"]), player(2, ["PG"])], ["PG", "G"]),
    [2, 1],
  );
  assert.equal(
    matchRoster([player(1, ["C"]), player(2, ["C"])], ["PG", "C"]),
    null,
  );
  assert.equal(
    matchRoster(
      [player(1, ["PG"]), player(2, ["G"]), player(3, ["PG", "G"])],
      ["PG", "G"],
    ),
    null,
  );
});
test("missing projections stay distinct from zero; points require every weighted field", () => {
  const zero = player(1, ["UTIL"], { PTS: 0, GP: 10 }),
    missing = player(2, ["UTIL"], { GP: 10 });
  for (const ascending of [false, true])
    assert.equal(
      rankPlayers([missing, zero], defaultSettings, "PTS", ascending)[0].id,
      zero.id,
    );
  assert.equal(value(zero, "PTS", defaultSettings), 0);
  assert.equal(value(missing, "PTS", defaultSettings), null);
  assert.equal(value(zero, "FP", defaultSettings), null);
  assert.equal(
    value(
      player(3, ["UTIL"], { PTS: 3, GP: 10 }),
      "FP",
      { ...defaultSettings, weights: { PTS: 0.1 } },
      false,
    ),
    0.3,
  );
});
test("roster percentages use attempts, and disclose incomplete coverage", () => {
  const roster = [
    player(1, ["UTIL"], { FGM: 1, FGA: 2 }),
    player(2, ["UTIL"], { FGM: 9, FGA: 10 }),
    player(3, ["UTIL"]),
  ];
  assert.deepEqual(rosterProjection(roster, "FG%"), {
    value: 10 / 12,
    coverage: 2,
    total: 3,
  });
});
test("adapter selects only exact season/source/split/period and never invents projections", () => {
  const source = {
    id: 1,
    fullName: "Player",
    proTeamId: 24,
    eligibleSlots: [4, 11, 12],
    stats: [
      {
        seasonId: 2026,
        statSourceId: 1,
        statSplitTypeId: 0,
        scoringPeriodId: 0,
        stats: { "0": 123, "42": 10 },
      },
    ],
  };
  const normalized = normalizeCatalog({ players: [{ player: source }] }, 2027);
  assert.equal(normalized.projectedCount, 0);
  assert.equal(normalized.players[0].totals.PTS, null);
  assert.deepEqual(normalized.players[0].positions, ["C", "UTIL", "BN"]);
  assert.equal(normalized.players[0].team, "SAS");
  assert.throws(() =>
    normalizeCatalog(
      { players: [{ player: source }, { player: source }] },
      2027,
    ),
  );
});
test("settings reject empty rosters, duplicate team order, invalid timers, and unsupported weights", () => {
  assert.equal(settingsSchema.safeParse(defaultSettings).success, true);
  assert.equal(
    settingsSchema.safeParse({
      ...defaultSettings,
      order: defaultSettings.order.map(() => 0),
    }).success,
    false,
  );
  assert.equal(
    settingsSchema.safeParse({ ...defaultSettings, seconds: 0 }).success,
    false,
  );
  assert.equal(
    settingsSchema.safeParse({
      ...defaultSettings,
      slots: Object.fromEntries(
        Object.keys(defaultSettings.slots).map((slot) => [slot, 0]),
      ),
    }).success,
    false,
  );
  assert.equal(
    settingsSchema.safeParse({ ...defaultSettings, weights: { DD: 5 } })
      .success,
    false,
  );
});
test("real ESPN lines restore omitted zeros only when totals reconcile", () => {
  const sample = JSON.parse(
    readFileSync(
      new URL("./fixtures/espn-2027-sample.json", import.meta.url),
      "utf8",
    ),
  );
  const catalog = normalizeCatalog(sample, 2027);
  const byName = (name: string) =>
    catalog.players.find((candidate) => candidate.name === name)!;
  const allen = byName("Jarrett Allen");
  assert.equal(allen.totals["3PA"], 7);
  assert.equal(allen.totals["3PM"], 0);
  assert.equal(allen.totals["3P%"], 0.055);
  const duren = byName("Jalen Duren");
  assert.equal(duren.totals["3PA"], 0);
  assert.equal(duren.totals["3P%"], null);
  assert.notEqual(value(duren, "FP", defaultSettings), null);
  assert.equal(byName("Jordan Miller").projected, false);
  assert.deepEqual(byName("Victor Wembanyama").positions, ["C", "UTIL", "BN"]);
  const broken = structuredClone(sample);
  const line = broken.players
    .find(
      (entry: { player: { fullName: string } }) =>
        entry.player.fullName === "Jarrett Allen",
    )
    .player.stats.find((stat: { seasonId: number }) => stat.seasonId === 2027);
  line.stats["0"] += 50;
  const unreconciled = normalizeCatalog(broken, 2027).players.find(
    (candidate) => candidate.name === "Jarrett Allen",
  )!;
  assert.equal(unreconciled.totals["3PM"], null);
  assert.equal(value(unreconciled, "FP", defaultSettings), null);
});
test("defaults match ESPN H2H Points except the app's 3RR format", () => {
  assert.equal(defaultSettings.format, "3rr");
  assert.equal(espnPointsDefaults.format, "snake");
  assert.equal(defaultSettings.teamCount, 10);
  assert.equal(defaultSettings.seconds, 90);
  assert.equal(defaultSettings.scoring, "points");
  assert.deepEqual(defaultSettings.weights, {
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
  });
  assert.equal(currentSeason(new Date("2026-10-01T00:00:00Z")), 2027);
  assert.equal(currentSeason(new Date("2027-03-01T00:00:00Z")), 2027);
});

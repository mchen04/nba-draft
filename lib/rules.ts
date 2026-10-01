import Decimal from "decimal.js";
import { Player, Room, Settings, Slot, Stat, slots } from "./model";

export function pickOrder(settings: Settings) {
  const rounds = Object.values(settings.slots).reduce(
    (sum, count) => sum + count,
    0,
  );
  return Array.from({ length: rounds }, (_, index) => {
    const round = index + 1;
    const forward =
      settings.format === "snake"
        ? round % 2 === 1
        : round === 1 || (round >= 4 && round % 2 === 0);
    return forward ? [...settings.order] : [...settings.order].reverse();
  }).flat();
}

export function rosterSlots(settings: Settings): Slot[] {
  return slots.flatMap((slot) => Array<Slot>(settings.slots[slot]).fill(slot));
}

export function matchRoster(
  players: Player[],
  configured: Slot[],
): (number | null)[] | null {
  if (players.length > configured.length) return null;
  const assigned: (number | null)[] = configured.map(() => null);
  const place = (playerIndex: number, seen: Set<number>): boolean => {
    for (let slotIndex = 0; slotIndex < configured.length; slotIndex++) {
      if (
        seen.has(slotIndex) ||
        !players[playerIndex].positions.includes(configured[slotIndex])
      )
        continue;
      seen.add(slotIndex);
      const previous = assigned[slotIndex];
      if (previous === null || place(previous, seen)) {
        assigned[slotIndex] = playerIndex;
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < players.length; index++)
    if (!place(index, new Set())) return null;
  return assigned.map((index) => (index === null ? null : players[index].id));
}

export function value(
  player: Player,
  stat: Stat | "FP",
  settings: Settings,
  perGame = true,
): number | null {
  let total: number | null;
  if (stat === "FP") {
    let score = new Decimal(0);
    for (const [key, weight] of Object.entries(settings.weights)) {
      if (!weight) continue;
      const input = player.totals[key as Stat];
      if (input === null || input === undefined) return null;
      score = score.plus(new Decimal(input).times(weight));
    }
    total = score.toNumber();
  } else total = player.totals[stat];
  if (total === null || total === undefined) return null;
  if (!perGame || stat.endsWith("%") || stat === "GP") return total;
  const games = player.totals.GP;
  return games !== null && games > 0 ? total / games : null;
}

export function nameKey(name: string) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
export function rankPlayers(
  players: Player[],
  settings: Settings,
  stat: Stat | "FP",
  ascending = false,
  perGame = true,
) {
  return [...players].sort((first, second) => {
    const firstValue = value(first, stat, settings, perGame),
      secondValue = value(second, stat, settings, perGame);
    if (firstValue === null && secondValue !== null) return 1;
    if (secondValue === null && firstValue !== null) return -1;
    if (
      firstValue !== null &&
      secondValue !== null &&
      firstValue !== secondValue
    )
      return ascending ? firstValue - secondValue : secondValue - firstValue;
    const firstName = nameKey(first.name),
      secondName = nameKey(second.name);
    return firstName < secondName
      ? -1
      : firstName > secondName
        ? 1
        : first.id - second.id;
  });
}

export function eligible(room: Room, slot: number, player: Player) {
  if (room.picks.some((pick) => pick.playerId === player.id)) return false;
  const ids = room.picks
    .filter((pick) => pick.slot === slot)
    .map((pick) => pick.playerId);
  const players = ids.map((id) =>
    room.catalog.players.find((candidate) => candidate.id === id)!,
  );
  return matchRoster([...players, player], rosterSlots(room.settings)) !== null;
}

export function rosterProjection(
  players: Player[],
  stat: Stat,
): { value: number | null; coverage: number; total: number } {
  const percentage =
    stat === "FG%"
      ? ["FGM", "FGA"]
      : stat === "FT%"
        ? ["FTM", "FTA"]
        : stat === "3P%"
          ? ["3PM", "3PA"]
          : null;
  const covered = players.filter((player) =>
    percentage
      ? percentage.every((key) => player.totals[key as Stat] !== null)
      : player.totals[stat] !== null,
  );
  if (!covered.length)
    return { value: null, coverage: 0, total: players.length };
  const sum = (key: string) =>
    covered.reduce((total, player) => total + player.totals[key as Stat]!, 0);
  return {
    value: percentage
      ? sum(percentage[1]) > 0
        ? sum(percentage[0]) / sum(percentage[1])
        : null
      : sum(stat),
    coverage: covered.length,
    total: players.length,
  };
}

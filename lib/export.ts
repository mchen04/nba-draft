import { Room } from "./model";
import { rosterFor } from "./engine";
import { pickOrder, rosterSlots } from "./rules";

function cell(input: unknown) {
  let text = input === null || input === undefined ? "" : String(input);
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function exportCsv(room: Room, kind: "picks" | "rosters" | "order") {
  const name = (slot: number) =>
    room.members.find((member) => member.slot === slot)?.name ??
    `Team ${slot + 1}`;
  const prefix = [
    room.id,
    room.version,
    `${room.settings.season - 1}–${String(room.settings.season).slice(-2)}`,
  ];
  let header: string[], rows: unknown[][];
  if (kind === "rosters") {
    header = [
      "draft_id",
      "result_version",
      "season",
      "draft_slot",
      "manager_name",
      "roster_slot",
      "espn_player_id",
      "player_name",
      "nba_team",
      "eligible_positions",
      "overall_pick",
    ];
    rows = Array.from({ length: room.settings.teamCount }, (_, slot) => {
      const assignments = rosterFor(room, slot)!;
      return rosterSlots(room.settings).map((position, index) => {
        const player = room.catalog.players.find(
          (candidate) => candidate.id === assignments[index],
        );
        const pick = room.picks.find(
          (candidate) => candidate.playerId === player?.id,
        );
        return [
          ...prefix,
          slot + 1,
          name(slot),
          position,
          player?.id,
          player?.name,
          player?.team,
          player?.positions.join("/"),
          pick ? pick.index + 1 : null,
        ];
      });
    }).flat();
  } else if (kind === "order") {
    header = [
      "draft_id",
      "result_version",
      "season",
      "overall_pick",
      "round",
      "pick_in_round",
      "draft_slot",
      "manager_name",
    ];
    rows = pickOrder(room.settings).map((slot, index) => [
      ...prefix,
      index + 1,
      Math.floor(index / room.settings.teamCount) + 1,
      (index % room.settings.teamCount) + 1,
      slot + 1,
      name(slot),
    ]);
  } else {
    header = [
      "draft_id",
      "result_version",
      "season",
      "overall_pick",
      "round",
      "pick_in_round",
      "draft_slot",
      "manager_name",
      "espn_player_id",
      "player_name",
      "nba_team",
      "eligible_positions",
      "selection_source",
      "picked_at_utc",
    ];
    rows = room.picks.map((pick) => {
      const player = room.catalog.players.find(
        (candidate) => candidate.id === pick.playerId,
      )!;
      return [
        ...prefix,
        pick.index + 1,
        Math.floor(pick.index / room.settings.teamCount) + 1,
        (pick.index % room.settings.teamCount) + 1,
        pick.slot + 1,
        name(pick.slot),
        player.id,
        player.name,
        player.team,
        player.positions.join("/"),
        pick.source,
        pick.at,
      ];
    });
  }
  return (
    "\ufeff" +
    [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") +
    "\r\n"
  );
}

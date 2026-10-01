import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PoolClient } from "pg";
import { z as zod } from "zod";
import { database } from "./db";
import { getCatalog } from "./espn";
import { Member, Room, Settings, View, settingsSchema } from "./model";
import {
  eligible,
  matchRoster,
  pickOrder,
  rankPlayers,
  rosterSlots,
} from "./rules";

export class DraftError extends Error {
  constructor(
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export const hash = (input: string) =>
  createHash("sha256").update(input).digest("hex");
const secret = () => randomBytes(24).toString("base64url");
const label = zod
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[^\u0000-\u001f\u007f]*$/);
const base = { requestId: zod.string().uuid() };
export const actionSchema = zod.discriminatedUnion("type", [
  zod.object({
    ...base,
    type: zod.literal("claim"),
    slot: zod.number().int().min(0).max(19),
    name: label,
    retryCredential: zod.string().regex(/^[a-f0-9]{64}$/),
  }),
  zod.object({
    ...base,
    type: zod.literal("recover"),
    code: zod.string().min(20).max(100),
  }),
  zod.object({ ...base, type: zod.literal("ready"), ready: zod.boolean() }),
  zod.object({
    ...base,
    type: zod.literal("settings"),
    settings: settingsSchema,
  }),
  zod.object({ ...base, type: zod.literal("refresh") }),
  zod.object({
    ...base,
    type: zod.literal("start"),
    acknowledge: zod.boolean(),
  }),
  zod.object({
    ...base,
    type: zod.literal("pick"),
    playerId: zod.number().int().positive(),
    expectedIndex: zod.number().int().min(0),
    forTeam: zod.boolean().optional(),
  }),
  zod.object({
    ...base,
    type: zod.literal("queue"),
    players: zod.array(zod.number().int().positive()).max(100),
  }),
  zod.object({ ...base, type: zod.literal("pause") }),
  zod.object({ ...base, type: zod.literal("resume") }),
  zod.object({
    ...base,
    type: zod.literal("undo"),
    expectedIndex: zod.number().int().min(1),
    expectedPlayerId: zod.number().int().positive(),
    expectedVersion: zod.number().int().positive(),
  }),
]);
type Action = zod.infer<typeof actionSchema>;
function claimSecrets(id: string, action: Extract<Action, { type: "claim" }>) {
  const key = `${id}:${action.requestId}:${action.retryCredential}`;
  return {
    token: hash(`claim-session:${key}`),
    recoveryCode: hash(`claim-recovery:${key}`),
  };
}
export const createSchema = zod.object({
  name: label,
  commissioner: label,
  settings: settingsSchema,
});
export function actorFor(room: Room, token: string | undefined) {
  return token
    ? room.members.find((member) => member.sessions.includes(hash(token)))
    : undefined;
}

export async function createRoom(
  name: string,
  commissioner: string,
  settings: Settings,
) {
  const catalog = await getCatalog(settings.season);
  const token = secret(),
    recoveryCode = secret();
  const room: Room = {
    id: randomUUID(),
    name,
    settings,
    phase: "lobby",
    deadline: null,
    remaining: null,
    picks: [],
    members: [
      {
        name: commissioner,
        slot: null,
        commissioner: true,
        sessions: [hash(token)],
        recovery: hash(recoveryCode),
        ready: false,
        queue: [],
      },
    ],
    catalog,
    ranking: [],
    version: 1,
    message: null,
  };
  await database().query("INSERT INTO nba_draft.rooms(id,data) VALUES($1,$2)", [
    room.id,
    JSON.stringify(room),
  ]);
  return { room, token, recoveryCode };
}

export function roomView(room: Room, token?: string, now = Date.now()): View {
  const actor = actorFor(room, token);
  const { players: _players, ...catalog } = room.catalog;
  return {
    id: room.id,
    name: room.name,
    settings: room.settings,
    phase: room.phase,
    deadline: room.deadline,
    remaining: room.remaining,
    picks: room.picks,
    version: room.version,
    message: room.message,
    members: room.members.map((member) => ({
      name: member.name,
      slot: member.slot,
      ready: member.ready,
    })),
    me: actor
      ? {
          slot: actor.slot,
          commissioner: actor.commissioner,
          ready: actor.ready,
        }
      : null,
    queue: actor?.queue ?? [],
    catalog,
    serverNow: now,
  };
}

async function appendPick(
  client: PoolClient,
  room: Room,
  playerId: number,
  source: Room["picks"][number]["source"],
  now: number,
  requestId: string | null,
  persist = true,
) {
  const order = pickOrder(room.settings),
    index = room.picks.length,
    slot = order[index];
  const player = room.catalog.players.find(
    (candidate) => candidate.id === playerId,
  );
  if (!player || slot === undefined || !eligible(room, slot, player))
    throw new DraftError(
      "Player is unavailable or cannot fit the current roster.",
    );
  const pick = {
    index,
    slot,
    playerId,
    source,
    at: new Date(now).toISOString(),
    requestId,
  };
  if (persist)
    await client.query(
      "INSERT INTO nba_draft.picks(room_id,pick_index,player_id,team_slot,source,picked_at) VALUES($1,$2,$3,$4,$5,$6)",
      [room.id, index, playerId, slot, source, pick.at],
    );
  room.picks.push(pick);
  room.version++;
  room.message = null;
  if (room.picks.length === order.length) {
    room.phase = "complete";
    room.deadline = null;
    room.remaining = null;
  } else room.deadline = now + room.settings.seconds * 1000;
}

async function catchUp(client: PoolClient, room: Room, now: number) {
  const initialPickCount = room.picks.length;
  const players = new Map(
    room.catalog.players.map((player) => [player.id, player]),
  );
  const order = pickOrder(room.settings);
  while (
    room.phase === "live" &&
    room.deadline !== null &&
    room.deadline <= now
  ) {
    const slot = order[room.picks.length];
    const member = room.members.find((candidate) => candidate.slot === slot);
    const legal = (id: number) => {
      const player = players.get(id);
      return player && eligible(room, slot, player);
    };
    const queued = member?.queue.find(legal),
      fallback = queued ?? room.ranking.find(legal);
    if (fallback === undefined) {
      room.phase = "paused";
      room.deadline = null;
      room.remaining = room.settings.seconds * 1000;
      room.message =
        "No remaining player fits this roster. Commissioner must undo the latest pick to resolve roster capacity.";
      room.version++;
      break;
    }
    await appendPick(
      client,
      room,
      fallback,
      queued === undefined ? "ranking" : "queue",
      room.deadline,
      null,
      false,
    );
  }
  const automatic = room.picks.slice(initialPickCount);
  if (automatic.length)
    await client.query(
      "INSERT INTO nba_draft.picks(room_id,pick_index,player_id,team_slot,source,picked_at) SELECT $1, * FROM unnest($2::integer[],$3::bigint[],$4::integer[],$5::text[],$6::timestamptz[])",
      [
        room.id,
        automatic.map((pick) => pick.index),
        automatic.map((pick) => pick.playerId),
        automatic.map((pick) => pick.slot),
        automatic.map((pick) => pick.source),
        automatic.map((pick) => pick.at),
      ],
    );
}

function requireCommissioner(member: Member | undefined) {
  if (!member?.commissioner)
    throw new DraftError("Only the commissioner can do this.", 403);
}
function requireLobby(room: Room) {
  if (room.phase !== "lobby")
    throw new DraftError("Settings and claims are locked after start.");
}

export async function transactRoom(
  id: string,
  token?: string,
  action?: Action,
) {
  if (!zod.string().uuid().safeParse(id).success)
    throw new DraftError("Room not found.", 404);
  const client = await database().connect();
  let issuedToken: string | undefined,
    recoveryCode: string | undefined,
    failure: DraftError | undefined;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT data FROM nba_draft.rooms WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!result.rows.length) throw new DraftError("Room not found.", 404);
    const room = result.rows[0].data as Room;
    const originalVersion = room.version;
    const clock = await client.query("SELECT clock_timestamp() AS now");
    const now = new Date(clock.rows[0].now).getTime();
    await catchUp(client, room, now);
    const settled = JSON.stringify(room);
    await client.query("SAVEPOINT command");
    let member = actorFor(room, token);
    try {
      if (action) {
        const receipt = await client.query(
          "SELECT actor,payload_hash FROM nba_draft.requests WHERE room_id=$1 AND request_id=$2",
          [id, action.requestId],
        );
        const actor =
          action.type === "claim"
            ? `claim:${hash(action.retryCredential)}`
            : token
              ? hash(token)
              : "invite";
        const payloadHash = hash(JSON.stringify(action));
        if (receipt.rows.length) {
          if (
            receipt.rows[0].actor !== actor ||
            receipt.rows[0].payload_hash !== payloadHash
          )
            throw new DraftError("Request key belongs to a different action.");
          if (action.type === "claim") {
            const secrets = claimSecrets(id, action);
            if (actorFor(room, secrets.token)) {
              issuedToken = secrets.token;
              recoveryCode = secrets.recoveryCode;
            } else if (!member) {
              throw new DraftError(
                "Claim retry no longer restores this session. Use your recovery code.",
                403,
              );
            }
          }
        } else {
          if (action.type === "claim") {
            requireLobby(room);
            if (
              action.slot >= room.settings.teamCount ||
              room.members.some((candidate) => candidate.slot === action.slot)
            )
              throw new DraftError(
                "That slot is already claimed. Choose another.",
              );
            if (member?.slot !== null && member?.slot !== undefined)
              throw new DraftError("You already own a team.");
            if (!member) {
              const secrets = claimSecrets(id, action);
              issuedToken = secrets.token;
              recoveryCode = secrets.recoveryCode;
              member = {
                name: action.name,
                slot: action.slot,
                commissioner: false,
                sessions: [hash(issuedToken)],
                recovery: hash(recoveryCode),
                ready: false,
                queue: [],
              };
              room.members.push(member);
            } else {
              member.name = action.name;
              member.slot = action.slot;
            }
          } else if (action.type === "recover") {
            member = room.members.find(
              (candidate) => candidate.recovery === hash(action.code),
            );
            if (!member)
              throw new DraftError("Recovery code is not valid.", 403);
            issuedToken = secret();
            member.sessions = [...member.sessions.slice(-4), hash(issuedToken)];
          } else {
            if (!member)
              throw new DraftError(
                "Claim a team or enter your recovery code.",
                403,
              );
            if (action.type === "ready") {
              requireLobby(room);
              if (member.slot === null)
                throw new DraftError("Claim a team first.");
              member.ready = action.ready;
            }
            if (action.type === "queue") {
              if (member.slot === null)
                throw new DraftError("Claim a team first.");
              if (
                new Set(action.players).size !== action.players.length ||
                action.players.some(
                  (playerId) =>
                    !room.catalog.players.some(
                      (player) => player.id === playerId,
                    ),
                )
              )
                throw new DraftError(
                  "Queue must contain unique players from this room.",
                );
              member.queue = action.players;
            }
            if (action.type === "settings") {
              requireCommissioner(member);
              requireLobby(room);
              if (
                room.members.some(
                  (candidate) =>
                    candidate.slot !== null &&
                    candidate.slot >= action.settings.teamCount,
                )
              )
                throw new DraftError("Team count would remove a claimed slot.");
              if (action.settings.season !== room.catalog.season)
                room.catalog = await getCatalog(
                  action.settings.season,
                  false,
                  client,
                );
              room.settings = action.settings;
              room.members.forEach((candidate) => {
                candidate.ready = false;
                candidate.queue = candidate.queue.filter((playerId) =>
                  room.catalog.players.some((player) => player.id === playerId),
                );
              });
            }
            if (action.type === "refresh") {
              requireCommissioner(member);
              requireLobby(room);
              room.catalog = await getCatalog(
                room.settings.season,
                true,
                client,
              );
            }
            if (action.type === "start") {
              requireCommissioner(member);
              requireLobby(room);
              if (
                room.members.filter(
                  (candidate) => candidate.slot !== null && candidate.ready,
                ).length !== room.settings.teamCount
              )
                throw new DraftError("Every team must be claimed and ready.");
              const age = now - new Date(room.catalog.fetchedAt).getTime();
              if (age > 7 * 86400000)
                throw new DraftError(
                  "Cached pool is over seven days old. Refresh before start.",
                );
              if (
                (age > 86400000 ||
                  room.catalog.projectedCount === 0 ||
                  room.catalog.warning) &&
                !action.acknowledge
              )
                throw new DraftError(
                  "Acknowledge stale, missing, or cached source data before start.",
                );
              const allSlots = Array.from(
                { length: room.settings.teamCount },
                () => rosterSlots(room.settings),
              ).flat();
              const available = room.catalog.players.map(
                (player) => player.positions,
              );
              const assigned = new Map<number, number>();
              const place = (index: number, seen: Set<number>): boolean => {
                for (
                  let playerIndex = 0;
                  playerIndex < available.length;
                  playerIndex++
                ) {
                  if (
                    seen.has(playerIndex) ||
                    !available[playerIndex].includes(allSlots[index])
                  )
                    continue;
                  seen.add(playerIndex);
                  const previous = assigned.get(playerIndex);
                  if (previous === undefined || place(previous, seen)) {
                    assigned.set(playerIndex, index);
                    return true;
                  }
                }
                return false;
              };
              if (!allSlots.every((_, index) => place(index, new Set())))
                throw new DraftError(
                  "Player pool cannot fill all configured positions.",
                );
              room.ranking = rankPlayers(
                room.catalog.players,
                room.settings,
                room.settings.fallback,
                room.settings.fallback === "TO",
              ).map((player) => player.id);
              room.phase = "live";
              room.deadline = now + room.settings.seconds * 1000;
              room.remaining = null;
            }
            if (action.type === "pick") {
              if (room.phase !== "live")
                throw new DraftError("Draft is not running.");
              if (action.expectedIndex !== room.picks.length)
                throw new DraftError(
                  "The turn changed. Refresh your selection.",
                );
              const slot = pickOrder(room.settings)[room.picks.length];
              if (action.forTeam) requireCommissioner(member);
              else if (member.slot !== slot)
                throw new DraftError("It is not your turn.", 403);
              await appendPick(
                client,
                room,
                action.playerId,
                action.forTeam ? "commissioner" : "manual",
                now,
                action.requestId,
              );
            }
            if (action.type === "pause") {
              requireCommissioner(member);
              if (room.phase !== "live")
                throw new DraftError("Only a running draft can pause.");
              room.remaining = Math.max(0, room.deadline! - now);
              room.deadline = null;
              room.phase = "paused";
            }
            if (action.type === "resume") {
              requireCommissioner(member);
              if (room.phase !== "paused")
                throw new DraftError("Draft is not paused.");
              const slot = pickOrder(room.settings)[room.picks.length];
              if (
                !room.catalog.players.some((player) =>
                  eligible(room, slot, player),
                )
              )
                throw new DraftError(
                  "Resolve roster capacity by undoing the latest pick first.",
                );
              room.deadline =
                now + (room.remaining ?? room.settings.seconds * 1000);
              room.remaining = null;
              room.phase = "live";
              room.message = null;
            }
            if (action.type === "undo") {
              requireCommissioner(member);
              if (
                !room.picks.length ||
                action.expectedIndex !== room.picks.length ||
                action.expectedPlayerId !== room.picks.at(-1)?.playerId ||
                action.expectedVersion !== room.version
              )
                throw new DraftError("Latest pick changed. Review it again.");
              room.picks.pop();
              await client.query(
                "DELETE FROM nba_draft.picks WHERE room_id=$1 AND pick_index=$2",
                [id, room.picks.length],
              );
              room.phase = "paused";
              room.deadline = null;
              room.remaining = room.settings.seconds * 1000;
              room.message =
                "Latest pick undone. Review the roster, then resume with a full clock.";
            }
          }
          room.version++;
          if (!issuedToken || action.type === "claim")
            await client.query(
              "INSERT INTO nba_draft.requests(room_id,request_id,actor,payload_hash) VALUES($1,$2,$3,$4)",
              [id, action.requestId, actor, payloadHash],
            );
        }
      }
    } catch (error) {
      if (!(error instanceof DraftError)) throw error;
      await client.query("ROLLBACK TO SAVEPOINT command");
      Object.assign(room, JSON.parse(settled));
      failure = error;
    }
    if (room.version !== originalVersion)
      await client.query("UPDATE nba_draft.rooms SET data=$2 WHERE id=$1", [
        id,
        JSON.stringify(room),
      ]);
    await client.query("COMMIT");
    if (failure) throw failure;
    return {
      room,
      token: issuedToken,
      recoveryCode,
      view: roomView(room, issuedToken ?? token, now),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function rosterFor(room: Room, slot: number) {
  const players = room.picks
    .filter((pick) => pick.slot === slot)
    .map(
      (pick) =>
        room.catalog.players.find((player) => player.id === pick.playerId)!,
    );
  return matchRoster(players, rosterSlots(room.settings));
}

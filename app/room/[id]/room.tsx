"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Catalog,
  Player,
  Settings,
  Slot,
  Stat,
  View,
  categoryStats,
  statIds,
} from "@/lib/model";
import {
  matchRoster,
  pickOrder,
  rankPlayers,
  rosterProjection,
  rosterSlots,
  value,
} from "@/lib/rules";
import { SettingsEditor } from "@/app/components/settings";

type Tab = "Players" | "Queue" | "Roster" | "Board";
type Command = Record<string, unknown> & { type: string };
function format(input: number | null, stat: string) {
  return input === null
    ? "—"
    : stat.endsWith("%")
      ? `${(input * 100).toFixed(1)}%`
      : stat === "GP"
        ? String(input)
        : input.toFixed(1);
}
function clock(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function DraftRoom({ id }: { id: string }) {
  const [room, setRoom] = useState<View | null>(null),
    [catalog, setCatalog] = useState<Catalog | null>(null);
  const [connected, setConnected] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false),
    [now, setNow] = useState(0),
    [offset, setOffset] = useState(0);
  const [tab, setTab] = useState<Tab>("Players"),
    [search, setSearch] = useState(""),
    [position, setPosition] = useState(""),
    [team, setTeam] = useState("");
  const [sort, setSort] = useState<Stat | "FP">("PTS"),
    [ascending, setAscending] = useState(false),
    [rankMode, setRankMode] = useState(false),
    [perGame, setPerGame] = useState(true),
    [showDrafted, setShowDrafted] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null),
    [details, setDetails] = useState(false),
    [limit, setLimit] = useState(100);
  const [rosterTeam, setRosterTeam] = useState<number | null>(null),
    [claimName, setClaimName] = useState(""),
    [claimSlot, setClaimSlot] = useState(0);
  const [recovery, setRecovery] = useState(""),
    [recoveryCode, setRecoveryCode] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null),
    [settingsOpen, setSettingsOpen] = useState(false),
    [acknowledge, setAcknowledge] = useState(false),
    [undo, setUndo] = useState(false),
    [forTeam, setForTeam] = useState(false);
  const [retry, setRetry] = useState<{ body: string; label: string } | null>(
    null,
  );
  const fetching = useRef(false),
    latestVersion = useRef(-1),
    sortInitialized = useRef(false);
  const pendingAction = useRef<AbortController | null>(null);
  const accept = useCallback((view: View) => {
    if (view.version >= latestVersion.current) {
      latestVersion.current = view.version;
      setRoom(view);
    }
    setOffset(view.serverNow - Date.now());
    setConnected(true);
  }, []);
  const load = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const response = await fetch(`/api/rooms/${id}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      accept(result);
    } catch {
      setConnected(false);
    } finally {
      fetching.current = false;
    }
  }, [id, accept]);
  const loadCatalog = useCallback(async () => {
    const response = await fetch(`/api/rooms/${id}?catalog=1`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    setCatalog(result);
  }, [id]);
  useEffect(() => {
    load();
    loadCatalog().catch((failure) => setError(failure.message));
    setRecoveryCode(sessionStorage.getItem(`recovery_${id}`) ?? "");
    const poll = setInterval(load, 2000),
      tick = setInterval(() => setNow(Date.now()), 250);
    const reconnect = () => load();
    window.addEventListener("online", reconnect);
    const offline = () => {
      setConnected(false);
      pendingAction.current?.abort();
    };
    window.addEventListener("offline", offline);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      pendingAction.current?.abort();
      window.removeEventListener("online", reconnect);
      window.removeEventListener("offline", offline);
    };
  }, [id, load, loadCatalog]);
  useEffect(() => {
    if (room && !sortInitialized.current) {
      setSort(room.settings.scoring === "points" ? "FP" : "PTS");
      sortInitialized.current = true;
    }
  }, [room]);
  useEffect(() => {
    if (
      room &&
      catalog &&
      (room.catalog.fetchedAt !== catalog.fetchedAt ||
        room.catalog.season !== catalog.season)
    )
      loadCatalog().catch((failure) => setError(failure.message));
  }, [room, catalog, loadCatalog]);
  useEffect(() => {
    if (room?.phase !== "lobby" && window.innerWidth < 768) {
      const workspace = document.querySelector(".workspace");
      if (workspace)
        window.scrollTo({
          top: window.scrollY + workspace.getBoundingClientRect().top - 140,
        });
    }
  }, [tab, room?.phase]);
  async function send(
    command: Command,
    label = "Action saved",
    savedBody?: string,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const payload =
      savedBody ??
      JSON.stringify({ ...command, requestId: crypto.randomUUID() });
    const controller = new AbortController();
    pendingAction.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`/api/rooms/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) {
        setRetry(null);
        throw new Error(result.error);
      }
      accept(result);
      setRetry(null);
      setNotice(label);
      if (result.recoveryCode) {
        setRecoveryCode(result.recoveryCode);
        sessionStorage.setItem(`recovery_${id}`, result.recoveryCode);
      }
      if (command.type === "pick") {
        setSelectedId(null);
        setDetails(false);
      }
      if (command.type === "settings") {
        setSettingsOpen(false);
        await loadCatalog();
      }
      if (command.type === "refresh") await loadCatalog();
    } catch (failure) {
      if (
        failure instanceof TypeError ||
        (failure instanceof Error && failure.name === "AbortError")
      ) {
        setConnected(false);
        setRetry({ body: payload, label });
        setError(
          "Connection lost. The action may already be saved. Reconnect, then retry the same request.",
        );
      } else
        setError(
          failure instanceof Error
            ? failure.message
            : "Action failed. Try again.",
        );
    } finally {
      clearTimeout(timeout);
      if (pendingAction.current === controller) pendingAction.current = null;
      setBusy(false);
    }
  }
  const players = catalog?.players ?? [],
    playerMap = useMemo(
      () => new Map(players.map((player) => [player.id, player])),
      [players],
    );
  const order = useMemo(
    () => (room ? pickOrder(room.settings) : []),
    [room?.settings],
  );
  const currentIndex = room?.picks.length ?? 0,
    currentSlot = order[currentIndex],
    mySlot = room?.me?.slot ?? null;
  const drafted = useMemo(
    () => new Set(room?.picks.map((pick) => pick.playerId) ?? []),
    [room?.picks],
  );
  const selected = selectedId === null ? null : playerMap.get(selectedId);
  const myPlayers =
    room?.picks
      .filter((pick) => pick.slot === mySlot)
      .map((pick) => playerMap.get(pick.playerId)!)
      .filter(Boolean) ?? [];
  const configured = room ? rosterSlots(room.settings) : [];
  const myAssignment = matchRoster(myPlayers, configured) ?? [];
  const needs = configured.filter((_, index) => myAssignment[index] === null);
  const nextIndex =
    mySlot === null
      ? -1
      : order.findIndex(
          (slot, index) => index >= currentIndex && slot === mySlot,
        );
  const managerName = (slot: number | undefined) =>
    room?.members.find((member) => member.slot === slot)?.name ??
    `Team ${(slot ?? 0) + 1}`;
  const queue =
    room?.queue
      .map((playerId) => playerMap.get(playerId))
      .filter((player): player is Player => !!player) ?? [];
  const availableQueue = queue.filter((player) => !drafted.has(player.id));
  const filtered = useMemo(() => {
    if (!room) return [];
    const sorted = rankPlayers(
      players.filter(
        (player) =>
          (showDrafted || !drafted.has(player.id)) &&
          player.name.toLowerCase().includes(search.toLowerCase()) &&
          (!position || player.positions.includes(position as Slot)) &&
          (!team || player.team === team),
      ),
      room.settings,
      rankMode ? room.settings.fallback : sort,
      rankMode ? room.settings.fallback === "TO" : ascending,
      rankMode ? true : perGame,
    );
    return rankMode && ascending ? sorted.reverse() : sorted;
  }, [
    players,
    room?.settings,
    search,
    position,
    team,
    sort,
    ascending,
    rankMode,
    perGame,
    drafted,
    showDrafted,
  ]);
  const rank = useMemo(
    () =>
      room
        ? new Map(
            rankPlayers(
              players,
              room.settings,
              room.settings.fallback,
              room.settings.fallback === "TO",
            ).map((player, index) => [player.id, index + 1]),
          )
        : new Map<number, number>(),
    [players, room?.settings],
  );
  if (!room || !catalog)
    return (
      <main className="setup-page">
        <h1>NBA Draft Room</h1>
        <p role="status">
          {error ||
            (connected
              ? "Loading player pool…"
              : "Connecting to the saved draft…")}
        </p>
        <button
          onClick={() => {
            load();
            loadCatalog().catch((failure) => setError(failure.message));
          }}
        >
          Reconnect
        </button>
        <a href="/">Create a new room</a>
      </main>
    );
  const seconds =
    room.phase === "paused"
      ? (room.remaining ?? 0)
      : room.deadline === null
        ? 0
        : room.deadline - ((now || Date.now()) + offset);
  const myTurn = mySlot === currentSlot;
  const acting = forTeam && room.me?.commissioner;
  const pickingPlayers = acting
    ? room.picks
        .filter((pick) => pick.slot === currentSlot)
        .map((pick) => playerMap.get(pick.playerId)!)
        .filter(Boolean)
    : myPlayers;
  const fits =
    !!selected &&
    matchRoster([...pickingPlayers, selected], configured) !== null;
  const canPick =
    room.phase === "live" &&
    (myTurn || acting) &&
    !!selected &&
    !drafted.has(selected.id) &&
    fits &&
    connected &&
    !busy &&
    !retry;
  const columns: (Stat | "FP")[] =
    room.settings.scoring === "points"
      ? ["FP", "PTS", "REB", "AST", "STL", "BLK", "TO", "GP"]
      : [...room.settings.categories, "GP"];
  const viewedTeam = rosterTeam ?? mySlot ?? 0;
  const rosterPlayers = room.picks
    .filter((pick) => pick.slot === viewedTeam)
    .map((pick) => playerMap.get(pick.playerId)!)
    .filter(Boolean);
  const rosterAssignment = matchRoster(rosterPlayers, configured) ?? [];
  function toggleQueue(playerId: number) {
    const queued = room!.queue.includes(playerId);
    send(
      {
        type: "queue",
        players: queued
          ? room!.queue.filter((candidate) => candidate !== playerId)
          : [...room!.queue, playerId],
      },
      queued ? "Player removed from queue" : "Player queued",
    );
  }
  function moveQueue(index: number, direction: number) {
    const updated = [...room!.queue];
    [updated[index], updated[index + direction]] = [
      updated[index + direction],
      updated[index],
    ];
    send({ type: "queue", players: updated }, "Queue order saved");
  }
  function showRoster(slot: number) {
    setRosterTeam(slot);
    setTab("Roster");
  }
  const queuePanel = (
    <>
      <div className="panel-heading">
        <h2>My queue</h2>
        <span>{availableQueue.length} available</span>
      </div>
      {mySlot === null ? (
        <p className="empty">Claim a team to build a private queue.</p>
      ) : queue.length === 0 ? (
        <p className="empty">
          Use + Queue beside a player. Your first available eligible player is
          your timeout pick.
        </p>
      ) : (
        <ol className="queue-list">
          {queue.map((player, index) => (
            <li
              key={player.id}
              className={
                drafted.has(player.id)
                  ? "taken"
                  : selectedId === player.id
                    ? "selected"
                    : ""
              }
            >
              <button
                className="queue-player"
                onClick={() => setSelectedId(player.id)}
                aria-label={`Select ${player.name} from queue`}
              >
                <strong>{player.name}</strong>
                <small>
                  {player.positions
                    .filter((slot) => !["UTIL", "BN"].includes(slot))
                    .join("/")}{" "}
                  · {player.team}
                  {drafted.has(player.id) ? " · Drafted" : ""}
                </small>
              </button>
              <div className="queue-actions">
                <button
                  aria-label={`Move ${player.name} up`}
                  disabled={index === 0 || busy || !connected}
                  onClick={() => moveQueue(index, -1)}
                >
                  ↑
                </button>
                <button
                  aria-label={`Move ${player.name} down`}
                  disabled={index === queue.length - 1 || busy || !connected}
                  onClick={() => moveQueue(index, 1)}
                >
                  ↓
                </button>
                <button
                  aria-label={`Remove ${player.name} from queue`}
                  disabled={busy || !connected}
                  onClick={() => toggleQueue(player.id)}
                >
                  ×
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="hint pad">
        Private to your team. Queued players still must fit your roster.
      </p>
    </>
  );
  const rosterPanel = (
    <>
      <div className="panel-heading">
        <h2>Roster</h2>
        <button onClick={() => setRosterTeam(mySlot ?? 0)}>My team</button>
      </div>
      <label className="pad roster-select">
        View team
        <select
          value={viewedTeam}
          onChange={(event) => setRosterTeam(Number(event.target.value))}
        >
          {Array.from({ length: room.settings.teamCount }, (_, slot) => (
            <option key={slot} value={slot}>
              {slot + 1}. {managerName(slot)}
            </option>
          ))}
        </select>
      </label>
      <ul className="roster-list">
        {configured.map((slot, index) => {
          const player = playerMap.get(rosterAssignment[index] ?? -1);
          return (
            <li key={index}>
              <span className={`position pos-${slot}`}>{slot}</span>
              {player ? (
                <button onClick={() => setSelectedId(player.id)}>
                  <strong>{player.name}</strong>
                  <small>
                    {player.team} ·{" "}
                    {player.positions
                      .filter((position) => !["UTIL", "BN"].includes(position))
                      .join("/")}
                  </small>
                </button>
              ) : (
                <span className="open-slot">Open slot</span>
              )}
            </li>
          );
        })}
      </ul>
      <details className="pad">
        <summary>Projected roster totals</summary>
        <p className="hint">
          Totals, not game averages. Percentage uses total makes / attempts.
          Missing inputs show partial coverage.
        </p>
        {categoryStats.map((stat) => {
          const total = rosterProjection(rosterPlayers, stat);
          return (
            <div className="stat-pair" key={stat}>
              <span>{stat}</span>
              <span>
                {format(total.value, stat)}{" "}
                <small>
                  {total.coverage}/{total.total} players
                </small>
              </span>
            </div>
          );
        })}
      </details>
    </>
  );
  return (
    <div className="draft-app">
      <header className="draft-header">
        <div className="room-title">
          <strong>{room.name}</strong>
          <small>
            NBA {room.settings.season - 1}–
            {String(room.settings.season).slice(-2)} ·{" "}
            {room.settings.format === "3rr" ? "3RR" : "Snake"}
          </small>
        </div>
        <div
          className={`clock-block ${myTurn && room.phase === "live" ? "on-clock" : ""}`}
        >
          <span>
            {room.phase === "complete"
              ? "Draft complete"
              : room.phase === "lobby"
                ? "Waiting for teams"
                : `${room.phase === "paused" ? "Paused · " : "On clock · "}${managerName(currentSlot)}`}
          </span>
          <strong>
            {room.phase === "lobby"
              ? "—"
              : room.phase === "complete"
                ? "✓"
                : clock(seconds)}
          </strong>
        </div>
        <div className="my-turn">
          <strong>
            {nextIndex < 0
              ? "No picks left"
              : room.phase === "lobby"
                ? `Your first: #${nextIndex + 1}`
                : nextIndex === currentIndex
                  ? "Your turn"
                  : `Your next: #${nextIndex + 1}`}
          </strong>
          <span className={connected ? "connection" : "connection lost"}>
            {connected ? "Connected" : "Disconnected · picks disabled"}
          </span>
        </div>
      </header>
      <div className="room-summary">
        <button onClick={() => showRoster(mySlot ?? 0)}>
          My needs:{" "}
          {mySlot === null
            ? "Claim a team"
            : needs.length
              ? needs.join(" · ")
              : "Roster full"}
        </button>
        <button onClick={() => setTab("Queue")}>
          Queue: {availableQueue[0]?.name ?? "Empty"} ({availableQueue.length})
        </button>
      </div>
      {!connected && (
        <p role="alert" className="banner error">
          Connection lost. The server clock continues. Reconnect to see timeout
          picks.<button onClick={load}>Reconnect</button>
        </p>
      )}
      {error && (
        <div role="alert" className="banner error">
          {error}
          {retry && (
            <button
              disabled={!connected || busy}
              onClick={() =>
                send(JSON.parse(retry.body), retry.label, retry.body)
              }
            >
              Retry saved request
            </button>
          )}
        </div>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {room.message && (
        <p className="banner warning" role="status">
          {room.message}
        </p>
      )}
      {room.phase !== "lobby" && (
        <div className="pick-train" aria-label="Recent and upcoming picks">
          {order
            .slice(
              Math.max(0, currentIndex - 3),
              Math.min(order.length, currentIndex + 5),
            )
            .map((slot, relative) => {
              const index = Math.max(0, currentIndex - 3) + relative,
                pick = room.picks[index],
                player = pick ? playerMap.get(pick.playerId) : null;
              return (
                <button
                  key={index}
                  className={
                    index === currentIndex ? "current" : pick ? "picked" : ""
                  }
                  onClick={() => showRoster(slot)}
                >
                  <small>
                    R{Math.floor(index / room.settings.teamCount) + 1} · Pick{" "}
                    {index + 1}
                  </small>
                  <strong>
                    {player?.name ??
                      (index === currentIndex ? "On clock" : "Upcoming")}
                  </strong>
                  <span>{managerName(slot)}</span>
                </button>
              );
            })}
        </div>
      )}
      <div className="toolbar">
        <nav aria-label="Draft views">
          {(["Players", "Queue", "Roster", "Board"] as Tab[]).map((view) => (
            <button
              key={view}
              aria-current={tab === view ? "page" : undefined}
              onClick={() => setTab(view)}
            >
              {view}
              {view === "Queue" ? ` (${availableQueue.length})` : ""}
            </button>
          ))}
        </nav>
        {room.me?.commissioner && (
          <div className="commissioner-controls">
            {room.phase === "lobby" ? (
              <button
                onClick={() => {
                  setSettings(room.settings);
                  setSettingsOpen(!settingsOpen);
                }}
              >
                League settings
              </button>
            ) : (
              <>
                <button
                  disabled={busy || !connected || room.phase === "complete"}
                  onClick={() =>
                    send(
                      { type: room.phase === "paused" ? "resume" : "pause" },
                      room.phase === "paused"
                        ? "Draft resumed"
                        : "Draft paused",
                    )
                  }
                >
                  {room.phase === "paused" ? "Resume" : "Pause"}
                </button>
                <button
                  disabled={!room.picks.length || busy || !connected}
                  onClick={() => setUndo(!undo)}
                >
                  Undo latest
                </button>
                <label className="inline-check">
                  <input
                    type="checkbox"
                    checked={forTeam}
                    onChange={(event) => setForTeam(event.target.checked)}
                  />
                  Pick for on-clock team
                </label>
              </>
            )}
          </div>
        )}
      </div>
      {undo && (
        <div className="banner warning">
          Undo {playerMap.get(room.picks.at(-1)?.playerId ?? -1)?.name} (pick{" "}
          {currentIndex})? The room pauses with a full clock.
          <button
            onClick={() => {
              send(
                { type: "undo", expectedIndex: currentIndex },
                "Latest pick undone",
              );
              setUndo(false);
            }}
          >
            Confirm undo
          </button>
          <button onClick={() => setUndo(false)}>Cancel</button>
        </div>
      )}
      {room.phase === "lobby" && (
        <section className="lobby panel">
          <div className="panel-heading">
            <h2>Draft lobby</h2>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(location.href);
                  setNotice("Invite link copied");
                } catch {
                  setNotice(
                    "Copy the room address from your browser to invite managers.",
                  );
                }
              }}
            >
              Copy invite link
            </button>
          </div>
          <p className="pad hint">
            Share this room address. Everyone claims one team and marks ready.
            Settings lock when the draft starts.
          </p>
          <div className="team-grid">
            {Array.from({ length: room.settings.teamCount }, (_, slot) => {
              const member = room.members.find(
                (candidate) => candidate.slot === slot,
              );
              return (
                <button
                  key={slot}
                  disabled={!!member || mySlot !== null}
                  aria-pressed={claimSlot === slot}
                  onClick={() => setClaimSlot(slot)}
                >
                  <small>
                    Team {slot + 1} · first pick #
                    {room.settings.order.indexOf(slot) + 1}
                  </small>
                  <strong>{member?.name ?? "Open slot"}</strong>
                  <span>
                    {member
                      ? member.ready
                        ? "Ready"
                        : "Not ready"
                      : "Claim this team"}
                  </span>
                </button>
              );
            })}
          </div>
          {mySlot === null ? (
            <form
              className="claim-form"
              onSubmit={(event) => {
                event.preventDefault();
                send(
                  { type: "claim", name: claimName, slot: claimSlot },
                  "Team claimed",
                );
              }}
            >
              <label>
                Manager name
                <input
                  required
                  maxLength={60}
                  value={claimName}
                  onChange={(event) => setClaimName(event.target.value)}
                />
              </label>
              <button
                className="primary"
                disabled={
                  busy ||
                  !connected ||
                  room.members.some((member) => member.slot === claimSlot)
                }
              >
                Claim team {claimSlot + 1}
              </button>
            </form>
          ) : (
            <button
              className="primary"
              disabled={busy || !connected}
              onClick={() =>
                send(
                  { type: "ready", ready: !room.me!.ready },
                  room.me?.ready ? "Team marked not ready" : "Team ready",
                )
              }
            >
              {room.me?.ready ? "Mark not ready" : "Ready to draft"}
            </button>
          )}
          {room.me?.commissioner && (
            <div className="start-controls">
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={acknowledge}
                  onChange={(event) => setAcknowledge(event.target.checked)}
                />
                I accept any stale, missing, or cached source data shown below
              </label>
              <button
                className="primary"
                disabled={
                  busy ||
                  !connected ||
                  room.members.filter(
                    (member) => member.slot !== null && member.ready,
                  ).length !== room.settings.teamCount
                }
                onClick={() =>
                  send({ type: "start", acknowledge }, "Draft started")
                }
              >
                Start draft
              </button>
            </div>
          )}
        </section>
      )}
      {settingsOpen && settings && (
        <section className="panel settings-panel">
          <h2>League settings</h2>
          <SettingsEditor settings={settings} onChange={setSettings} />
          <button
            className="primary"
            disabled={busy || !connected}
            onClick={() =>
              send(
                { type: "settings", settings },
                "Settings saved; all teams must mark ready again",
              )
            }
          >
            Save league settings
          </button>
          <button onClick={() => setSettingsOpen(false)}>Cancel</button>
        </section>
      )}
      {!room.me && (
        <details className="panel recovery-panel">
          <summary>Recover your team on another device</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              send({ type: "recover", code: recovery }, "Ownership restored");
              setRecovery("");
            }}
          >
            <label>
              Recovery code
              <input
                autoComplete="off"
                type="password"
                value={recovery}
                onChange={(event) => setRecovery(event.target.value)}
                required
              />
            </label>
            <button className="primary" disabled={busy || !connected}>
              Recover team
            </button>
          </form>
        </details>
      )}
      {recoveryCode && (
        <details className="panel recovery-panel">
          <summary>Save your private recovery code</summary>
          <p>
            This code restores your team and commissioner rights on another
            device. Do not share it with other managers.
          </p>
          <code>{recoveryCode}</code>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(recoveryCode);
                setNotice("Recovery code copied");
              } catch {
                setNotice("Select and copy your recovery code.");
              }
            }}
          >
            Copy recovery code
          </button>
          <button
            onClick={() => {
              sessionStorage.removeItem(`recovery_${id}`);
              setRecoveryCode("");
            }}
          >
            I saved it · hide
          </button>
        </details>
      )}
      {room.phase === "complete" && (
        <section className="panel completion">
          <h2>Draft complete</h2>
          <p>
            {room.picks.length} picks saved. Export below for manual ESPN entry.
            No ESPN roster changes occur.
          </p>
        </section>
      )}
      <main className={`workspace view-${tab.toLowerCase()}`}>
        <aside className="panel queue-panel">{queuePanel}</aside>
        <section className="panel players-panel" hidden={tab !== "Players"}>
          <div className="panel-heading">
            <h2>Available players</h2>
            <span>{filtered.length} players</span>
          </div>
          <div className={`player-filters ${filtersOpen ? "expanded" : ""}`}>
            <label className="search-label">
              Search players
              <input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setLimit(100);
                }}
                placeholder="Search by name"
              />
            </label>
            <button
              className="mobile-filter-toggle"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen(!filtersOpen)}
            >
              {filtersOpen ? "Hide filters" : "Filters"}
            </button>
            <button
              className="clear-search"
              aria-label="Clear search"
              disabled={!search}
              onClick={() => setSearch("")}
            >
              Clear
            </button>
            <label>
              Position
              <select
                value={position}
                onChange={(event) => setPosition(event.target.value)}
              >
                <option value="">All positions</option>
                {["PG", "SG", "SF", "PF", "C", "G", "F", "UTIL", "BN"].map(
                  (slot) => (
                    <option key={slot}>{slot}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              NBA team
              <select
                value={team}
                onChange={(event) => setTeam(event.target.value)}
              >
                <option value="">All teams</option>
                {[...new Set(players.map((player) => player.team))]
                  .sort()
                  .map((nba) => (
                    <option key={nba}>{nba}</option>
                  ))}
              </select>
            </label>
            <label>
              Stats
              <select
                value={perGame ? "game" : "total"}
                onChange={(event) => setPerGame(event.target.value === "game")}
              >
                <option value="game">Per game</option>
                <option value="total">Season totals</option>
              </select>
            </label>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={showDrafted}
                onChange={(event) => setShowDrafted(event.target.checked)}
              />
              Show drafted
            </label>
            <label>
              Sort by
              <select
                value={rankMode ? "rank" : sort}
                onChange={(event) => {
                  setRankMode(event.target.value === "rank");
                  setAscending(false);
                  if (event.target.value !== "rank")
                    setSort(event.target.value as Stat | "FP");
                }}
              >
                <option value="rank">Rank (timeout order)</option>
                {columns.map((stat) => (
                  <option key={stat}>{stat}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="table-hint">
            Rank = configured {room.settings.fallback}/game timeout order. —
            means missing, not zero. Select a player, then use the named Draft
            button.
          </p>
          <div className="table-scroll">
            <table className="player-table">
              <thead>
                <tr>
                  <th
                    aria-sort={
                      rankMode
                        ? ascending
                          ? "descending"
                          : "ascending"
                        : "none"
                    }
                  >
                    <button
                      onClick={() => {
                        setRankMode(true);
                        setAscending(rankMode ? !ascending : false);
                      }}
                    >
                      Rank{rankMode ? (ascending ? " ↓" : " ↑") : ""}
                    </button>
                  </th>
                  <th>Player</th>
                  <th>Queue</th>
                  {columns.map((stat) => (
                    <th
                      key={stat}
                      aria-sort={
                        !rankMode && sort === stat
                          ? ascending
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        onClick={() => {
                          setSort(stat);
                          setRankMode(false);
                          setAscending(
                            sort === stat ? !ascending : stat === "TO",
                          );
                        }}
                      >
                        {stat}
                        {!rankMode && sort === stat
                          ? ascending
                            ? " ↑"
                            : " ↓"
                          : ""}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, limit).map((player) => (
                  <tr
                    key={player.id}
                    className={`${selectedId === player.id ? "selected" : ""} ${drafted.has(player.id) ? "taken" : ""}`}
                  >
                    <td>{rank.get(player.id)}</td>
                    <td>
                      <button
                        className="player-name"
                        aria-label={`Select ${player.name}`}
                        aria-pressed={selectedId === player.id}
                        onClick={() => setSelectedId(player.id)}
                      >
                        <strong>{player.name}</strong>
                        <small>
                          {player.positions
                            .filter((slot) => !["UTIL", "BN"].includes(slot))
                            .join("/")}{" "}
                          · {player.team}
                          {player.injury !== "ACTIVE"
                            ? ` · ${player.injury}`
                            : ""}
                          {!player.projected ? " · No projection" : ""}
                          {drafted.has(player.id) ? " · Drafted" : ""}
                        </small>
                      </button>
                      <button
                        className="mobile-queue"
                        aria-label={`${room.queue.includes(player.id) ? "Remove" : "Queue"} ${player.name}`}
                        disabled={
                          mySlot === null ||
                          busy ||
                          !connected ||
                          drafted.has(player.id)
                        }
                        onClick={() => toggleQueue(player.id)}
                      >
                        {room.queue.includes(player.id) ? "✓" : "+"}
                      </button>
                    </td>
                    <td>
                      <button
                        aria-label={`${room.queue.includes(player.id) ? "Remove" : "Queue"} ${player.name}`}
                        disabled={
                          mySlot === null ||
                          busy ||
                          !connected ||
                          drafted.has(player.id)
                        }
                        onClick={() => toggleQueue(player.id)}
                      >
                        {room.queue.includes(player.id)
                          ? "✓ Queued"
                          : "+ Queue"}
                      </button>
                    </td>
                    {columns.map((stat) => (
                      <td key={stat}>
                        {format(
                          value(player, stat, room.settings, perGame),
                          stat,
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 && (
            <p className="empty">No players match. Clear search or filters.</p>
          )}
          {filtered.length > limit && (
            <button className="more" onClick={() => setLimit(limit + 100)}>
              Show 100 more players
            </button>
          )}
        </section>
        <section className="panel board-panel" hidden={tab !== "Board"}>
          <div className="panel-heading">
            <h2>Draft board</h2>
            <span>
              {currentIndex}/{order.length} picks
            </span>
          </div>
          <div className="board-scroll">
            <table>
              <thead>
                <tr>
                  <th>Round</th>
                  {room.settings.order.map((slot) => (
                    <th key={slot}>
                      <button onClick={() => showRoster(slot)}>
                        {managerName(slot)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: configured.length }, (_, round) => (
                  <tr key={round}>
                    <th>{round + 1}</th>
                    {room.settings.order.map((slot) => {
                      const index = order.findIndex(
                          (candidate, index) =>
                            candidate === slot &&
                            Math.floor(index / room.settings.teamCount) ===
                              round,
                        ),
                        pick = room.picks[index],
                        player = pick ? playerMap.get(pick.playerId) : null;
                      return (
                        <td
                          key={slot}
                          className={
                            index === currentIndex && room.phase !== "complete"
                              ? "current"
                              : ""
                          }
                        >
                          <small>Pick {index + 1}</small>
                          <strong>
                            {player?.name ??
                              (index === currentIndex ? "On clock" : "—")}
                          </strong>
                          <small>
                            {player
                              ? `${player.team} · ${pick.source}`
                              : managerName(slot)}
                          </small>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <aside className="panel roster-panel">{rosterPanel}</aside>
      </main>
      <footer className="data-footer">
        <div>
          <a
            href="https://fantasy.espn.com/basketball/players/projections"
            target="_blank"
            rel="noreferrer"
          >
            Projection source: ESPN
          </a>{" "}
          · {catalog.projectedCount}/{players.length} current projections ·
          Retrieved {new Date(catalog.fetchedAt).toLocaleString()}
          <p>
            Season {catalog.season - 1}–{String(catalog.season).slice(-2)}.
            Source update time unknown. Live drafts use a frozen pool; ESPN
            outages do not stop picks.
          </p>
          {Date.now() - new Date(catalog.fetchedAt).getTime() > 86400000 && (
            <p className="warning">Cached pool is over 24 hours old.</p>
          )}
          {catalog.warning && <p className="warning">{catalog.warning}</p>}
          <details>
            <summary>Missing stat coverage and timeout rules</summary>
            <p>
              Per-game counting values = season totals / projected games. No
              current matching projection is shown as —.
            </p>
            <p>
              If everyone closes the room, the next server request resolves
              every expired turn at its original deadline. No browser or
              background loop is needed. This is lazy catch-up, not a continuous
              offline feed.
            </p>
            <p>
              Timeout picks skip drafted and ineligible queued players, then use
              the configured ranking. Settings and projections freeze at start.
            </p>
            <p>
              {Object.entries(catalog.missing)
                .map(([stat, count]) => `${stat}: ${count} missing`)
                .join(" · ")}
            </p>
          </details>
        </div>
        <div className="exports">
          {room.me &&
            (["order", "picks", "rosters"] as const).map((kind) => (
              <a
                className="button"
                key={kind}
                href={`/api/rooms/${id}/export?kind=${kind}`}
              >
                Export {kind} CSV
              </a>
            ))}
          {room.me?.commissioner && room.phase === "lobby" && (
            <button
              disabled={busy || !connected}
              onClick={() =>
                send({ type: "refresh" }, "Player pool refresh checked")
              }
            >
              Refresh ESPN cache
            </button>
          )}
        </div>
        <small>Independent app. Not affiliated with ESPN.</small>
      </footer>
      <div className="selection-tray">
        <div>
          {selected ? (
            <>
              <strong>{selected.name}</strong>
              <small>
                {selected.team} · {selected.positions.join("/")} ·{" "}
                {drafted.has(selected.id)
                  ? "Already drafted"
                  : !fits
                    ? "Cannot fit this roster"
                    : myTurn || acting
                      ? "Eligible for this turn"
                      : "Wait for your turn"}
              </small>
            </>
          ) : (
            <>
              <strong>Select a player</strong>
              <small>Selection stays when you change views.</small>
            </>
          )}
        </div>
        {selected && (
          <button onClick={() => setDetails(!details)}>
            {details ? "Close details" : "Player details"}
          </button>
        )}
        <button
          className="primary draft-button"
          disabled={!canPick}
          onClick={() =>
            selected &&
            send(
              {
                type: "pick",
                playerId: selected.id,
                expectedIndex: currentIndex,
                forTeam: !!acting,
              },
              `${selected.name} drafted`,
            )
          }
        >
          {selected ? `Draft ${selected.name}` : "Draft selected player"}
        </button>
      </div>
      {details && selected && (
        <section
          className="player-detail panel"
          aria-label="Selected player details"
        >
          <button onClick={() => setDetails(false)}>Close details</button>
          <h2>{selected.name}</h2>
          <p>
            {selected.team} · Eligible: {selected.positions.join(", ")} ·{" "}
            {selected.injury}
          </p>
          <p>
            {selected.projected
              ? "Current season projections"
              : "No current season projection"}
            . Counting rates use season totals / GP.
          </p>
          <div className="details-stats">
            {Object.keys(statIds).map((stat) => (
              <div className="stat-pair" key={stat}>
                <span>
                  {stat}
                  {selected.derived.includes(stat as Stat) ? " (derived)" : ""}
                </span>
                <strong>
                  {format(
                    value(selected, stat as Stat, room.settings, perGame),
                    stat,
                  )}
                </strong>
              </div>
            ))}
          </div>
          {room.settings.scoring === "points" && (
            <p>
              FP ={" "}
              {Object.entries(room.settings.weights)
                .filter(([, weight]) => !!weight)
                .map(([stat, weight]) => `${stat} × ${weight}`)
                .join(" + ")}{" "}
              / GP. Missing:{" "}
              {Object.entries(room.settings.weights)
                .filter(
                  ([stat, weight]) =>
                    weight && selected.totals[stat as Stat] === null,
                )
                .map(([stat]) => stat)
                .join(", ") || "none"}
              .
            </p>
          )}
          <button
            disabled={
              mySlot === null || busy || !connected || drafted.has(selected.id)
            }
            onClick={() => toggleQueue(selected.id)}
          >
            {room.queue.includes(selected.id)
              ? "Remove from queue"
              : "Add to queue"}
          </button>
        </section>
      )}
    </div>
  );
}

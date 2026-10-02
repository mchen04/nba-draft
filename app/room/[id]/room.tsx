"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Catalog,
  Player,
  Settings,
  Slot,
  Stat,
  Unchanged,
  View,
  categoryStats,
  slots,
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
import {
  RecentRoom,
  forgetRoom,
  recentRooms,
  rememberRoom,
} from "@/app/components/recent";

type Tab = "Lobby" | "Players" | "Queue" | "Roster" | "Board";
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
function age(milliseconds: number) {
  const minutes = Math.floor(milliseconds / 60000);
  if (minutes < 60) return `${Math.max(0, minutes)}m`;
  if (minutes < 2880) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}
const positionsOf = (player: Player) =>
  player.positions.filter((slot) => !["UTIL", "BN"].includes(slot)).join("/");
const injuryOf = (player: Player) =>
  ["ACTIVE", "UNKNOWN", ""].includes(player.injury)
    ? ""
    : player.injury === "DAY_TO_DAY"
      ? "DTD"
      : player.injury;

export default function DraftRoom({ id }: { id: string }) {
  const [room, setRoom] = useState<View | null>(null),
    [catalog, setCatalog] = useState<Catalog | null>(null);
  const [connected, setConnected] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false),
    [now, setNow] = useState(0),
    [offset, setOffset] = useState(0);
  const [tab, setTab] = useState<Tab | null>(null),
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
    [claimSlot, setClaimSlot] = useState<number | null>(null);
  const [recovery, setRecovery] = useState(""),
    [recoveryCode, setRecoveryCode] = useState(""),
    [showCode, setShowCode] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null),
    [undo, setUndo] = useState<{
      index: number;
      playerId: number;
      version: number;
      name: string;
    } | null>(null),
    [confirmLeave, setConfirmLeave] = useState(false),
    [forTeam, setForTeam] = useState(false);
  const [retry, setRetry] = useState<{ body: string; label: string } | null>(
    null,
  );
  // Reconnect bumps this so a failed player-data load runs again.
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [otherRooms, setOtherRooms] = useState<RecentRoom[]>([]);
  const fetching = useRef(false),
    latestVersion = useRef(-1),
    latestViewer = useRef(-1),
    readGeneration = useRef(0),
    sortInitialized = useRef(false),
    catalogLoading = useRef<string | null>(null);
  const pendingAction = useRef<AbortController | null>(null),
    menuRef = useRef<HTMLDetailsElement | null>(null);
  const accept = useCallback((view: View | Unchanged) => {
    if ("unchanged" in view)
      setRoom((current) =>
        current?.version === view.version &&
        current.commissionerIdle !== view.commissionerIdle
          ? { ...current, commissionerIdle: view.commissionerIdle }
          : current,
      );
    else if (view.version >= latestVersion.current) {
      latestVersion.current = view.version;
      latestViewer.current = view.viewer;
      setRoom(view);
    }
    setOffset(view.serverNow - Date.now());
    setConnected(true);
  }, []);
  const load = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    const generation = readGeneration.current;
    try {
      // The server answers "unchanged" when the room still has this version and viewer.
      const since =
        latestVersion.current >= 0
          ? `?since=${latestVersion.current}&viewer=${latestViewer.current}`
          : "";
      const response = await fetch(`/api/rooms/${id}${since}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (response.status === 404) forgetRoom(id);
      if (!response.ok) throw new Error(result.error);
      if (generation === readGeneration.current) accept(result);
    } catch {
      setConnected(false);
    } finally {
      fetching.current = false;
    }
  }, [id, accept]);
  // The player-data URL names the pool's digest, so the browser and CDN cache it.
  // A room saved before migration (no digest) still serves its own pool.
  const loadCatalog = useCallback(
    async (path: string | undefined) => {
      const response = await fetch(
        path ?? `/api/rooms/${id}?catalog=1`,
        path
          ? { signal: AbortSignal.timeout(30000) }
          : { cache: "no-store", signal: AbortSignal.timeout(30000) },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setCatalog(result);
    },
    [id],
  );
  useEffect(() => {
    load();
    setRecoveryCode(sessionStorage.getItem(`recovery_${id}`) ?? "");
    const pendingClaim = sessionStorage.getItem(`claim_retry_${id}`);
    if (pendingClaim) {
      setRetry(JSON.parse(pendingClaim));
      setError(
        "The claim may already be saved. Retry the saved request to restore your team.",
      );
    }
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
  }, [id, load]);
  useEffect(() => {
    if (room && !sortInitialized.current) {
      setSort(room.settings.scoring === "points" ? "FP" : "PTS");
      sortInitialized.current = true;
    }
  }, [room]);
  const roomName = room?.name,
    myLabel = !room
      ? ""
      : room.me?.slot == null
        ? room.me
          ? "No team"
          : "Viewing"
        : `Team ${room.me.slot + 1} · ${room.members.find((member) => member.slot === room.me!.slot)?.name ?? ""}`;
  useEffect(() => {
    if (!roomName) return;
    rememberRoom({ id, name: roomName, team: myLabel });
    setOtherRooms(recentRooms().filter((candidate) => candidate.id !== id));
  }, [id, roomName, myLabel]);
  useEffect(() => {
    if (!room) return;
    const { dataset, digest = "" } = room.catalog;
    if (
      (catalog && (catalog.digest ?? "") === digest) ||
      catalogLoading.current === digest
    )
      return;
    catalogLoading.current = digest;
    loadCatalog(digest ? `/api/catalog/${dataset}/${digest}` : undefined)
      .catch((failure) => setError(failure.message))
      .finally(() => {
        if (catalogLoading.current === digest) catalogLoading.current = null;
      });
  }, [room, catalog, loadCatalog, catalogAttempt]);
  const reconnect = () => {
    setError("");
    setCatalogAttempt((attempt) => attempt + 1);
    load();
  };
  async function send(command: Command, label = "Saved", savedBody?: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const payload =
      savedBody ??
      JSON.stringify({
        ...command,
        ...(command.type === "claim"
          ? {
              retryCredential: Array.from(
                crypto.getRandomValues(new Uint8Array(32)),
                (byte) => byte.toString(16).padStart(2, "0"),
              ).join(""),
            }
          : {}),
        requestId: crypto.randomUUID(),
      });
    if (command.type === "claim")
      sessionStorage.setItem(
        `claim_retry_${id}`,
        JSON.stringify({ body: payload, label }),
      );
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
        if (command.type === "claim")
          sessionStorage.removeItem(`claim_retry_${id}`);
        throw new Error(result.error);
      }
      readGeneration.current++;
      accept(result);
      if (menuRef.current) menuRef.current.open = false;
      setRetry(null);
      if (command.type === "claim")
        sessionStorage.removeItem(`claim_retry_${id}`);
      setNotice(label);
      if (result.recoveryCode) {
        setRecoveryCode(result.recoveryCode);
        sessionStorage.setItem(`recovery_${id}`, result.recoveryCode);
      }
      if (command.type === "leave") {
        setRecoveryCode("");
        sessionStorage.removeItem(`recovery_${id}`);
        setConfirmLeave(false);
      }
      if (command.type === "claim") setClaimSlot(null);
      if (command.type === "pick") {
        setSelectedId(null);
        setDetails(false);
      }
      if (command.type === "settings") setSettings(null);
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
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (
        menuRef.current?.open &&
        !menuRef.current.contains(event.target as Node)
      )
        menuRef.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !menuRef.current?.open) return;
      menuRef.current.open = false;
      menuRef.current.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
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
  const rosterOf = (slot: number | null) =>
    room?.picks
      .filter((pick) => pick.slot === slot)
      .map((pick) => playerMap.get(pick.playerId)!)
      .filter(Boolean) ?? [];
  const myPlayers = rosterOf(mySlot);
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
      <main className="shell loading">
        <p role="status">
          {error ||
            (connected
              ? "Loading player pool…"
              : "Connecting to the saved draft…")}
        </p>
        <div className="row">
          <button onClick={reconnect}>Reconnect</button>
          <a className="button" href="/">
            New room
          </a>
        </div>
      </main>
    );
  const lobby = room.phase === "lobby";
  const view: Tab =
    tab && (tab !== "Lobby" || lobby) ? tab : lobby ? "Lobby" : "Players";
  const tabs: Tab[] = [
    ...(lobby ? (["Lobby"] as Tab[]) : []),
    "Players",
    "Queue",
    "Roster",
    "Board",
  ];
  const remaining =
    room.phase === "paused"
      ? (room.remaining ?? 0)
      : room.deadline === null
        ? 0
        : room.deadline - ((now || Date.now()) + offset);
  const myTurn = mySlot === currentSlot;
  const commissioner = !!room.me?.commissioner;
  const acting = forTeam && commissioner;
  const pickingPlayers = acting ? rosterOf(currentSlot) : myPlayers;
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
      ? ["FP", "PTS", "REB", "AST", "STL", "BLK", "3PM", "TO", "GP"]
      : [...room.settings.categories, "GP"];
  const viewedTeam = rosterTeam ?? mySlot ?? 0;
  const rosterPlayers = rosterOf(viewedTeam);
  const rosterAssignment = matchRoster(rosterPlayers, configured) ?? [];
  const readyCount = room.members.filter(
    (member) => member.slot !== null && member.ready,
  ).length;
  const commissionerName =
    room.members.find((member) => member.commissioner)?.name ?? null;
  // Room metadata names the pinned dataset, its last ESPN check, and any refresh failure.
  const info = room.catalog;
  const dataAge =
    Date.now() - new Date(info.checkedAt ?? info.fetchedAt).getTime();
  const dataStale =
    dataAge > 8 * 86400000 || !!info.warning || info.projectedCount === 0;
  const openSlots = Array.from(
    { length: room.settings.teamCount },
    (_, slot) => slot,
  ).filter((slot) => !room.members.some((member) => member.slot === slot));
  function toggleQueue(playerId: number) {
    const queued = room!.queue.includes(playerId);
    send(
      {
        type: "queue",
        players: queued
          ? room!.queue.filter((candidate) => candidate !== playerId)
          : [...room!.queue, playerId],
      },
      queued ? "Removed from queue" : "Queued",
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
  const claimForm = (slot: number) => (
    <form
      className="claim-form"
      onSubmit={(event) => {
        event.preventDefault();
        send(
          { type: "claim", name: claimName, slot },
          mySlot === null ? "Team claimed" : "Team switched",
        );
      }}
    >
      <label>
        <span className="sr-only">Manager name</span>
        <input
          required
          maxLength={60}
          value={claimName}
          placeholder="Your name"
          aria-label="Manager name"
          onChange={(event) => setClaimName(event.target.value)}
        />
      </label>
      <button className="primary" disabled={busy || !connected}>
        {mySlot === null ? "Join" : "Move to"} team {slot + 1}
      </button>
      <button type="button" onClick={() => setClaimSlot(null)}>
        Cancel
      </button>
    </form>
  );
  const lobbyPanel = (
    <section
      className="panel lobby-panel"
      aria-label="Draft lobby"
      data-hidden={view !== "Lobby" || undefined}
    >
      <div className="panel-bar">
        <span>
          {readyCount}/{room.settings.teamCount} ready
          {commissionerName ? ` · Commissioner: ${commissionerName}` : ""}
        </span>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(location.href);
              setNotice("Invite link copied");
            } catch {
              setNotice("Copy the address bar to invite managers.");
            }
          }}
        >
          Copy invite link
        </button>
      </div>
      <div className="scroll">
        <ul className="team-grid">
          {Array.from({ length: room.settings.teamCount }, (_, slot) => {
            const member = room.members.find(
              (candidate) => candidate.slot === slot,
            );
            const mine = slot === mySlot;
            return (
              <li key={slot} className={mine ? "mine" : ""}>
                <div>
                  <small>
                    Team {slot + 1} · pick{" "}
                    {room.settings.order.indexOf(slot) + 1}
                  </small>
                  <strong>{member?.name ?? "Open"}</strong>
                  <span className={member?.ready ? "ok" : ""}>
                    {member
                      ? `${member.ready ? "Ready" : "Not ready"}${member.commissioner ? " · Commissioner" : ""}`
                      : ""}
                  </span>
                </div>
                {!member && (
                  <button
                    aria-label={`${mySlot === null ? "Claim" : "Switch to"} team ${slot + 1}`}
                    aria-expanded={claimSlot === slot}
                    disabled={busy || !connected}
                    onClick={() => {
                      setClaimSlot(claimSlot === slot ? null : slot);
                      if (!claimName && room.me)
                        setClaimName(
                          room.members.find(
                            (candidate) =>
                              candidate.slot === mySlot && mySlot !== null,
                          )?.name ?? "",
                        );
                    }}
                  >
                    {mySlot === null ? "Claim" : "Switch"}
                  </button>
                )}
                {mine && (
                  <button
                    className={room.me?.ready ? "" : "primary"}
                    disabled={busy || !connected}
                    onClick={() =>
                      send(
                        { type: "ready", ready: !room.me!.ready },
                        room.me?.ready ? "Marked not ready" : "Ready",
                      )
                    }
                  >
                    {room.me?.ready ? "Not ready" : "Ready"}
                  </button>
                )}
                {claimSlot === slot && !member && claimForm(slot)}
              </li>
            );
          })}
        </ul>
      </div>
      {commissioner && (
        <div className="panel-bar">
          <button
            onClick={() => setSettings(settings ? null : room.settings)}
            aria-expanded={!!settings}
          >
            League settings
          </button>
          <button
            className="primary"
            disabled={
              busy || !connected || readyCount !== room.settings.teamCount
            }
            onClick={() => send({ type: "start" }, "Draft started")}
          >
            Start draft
          </button>
        </div>
      )}
    </section>
  );
  const queuePanel = (
    <section
      className="panel queue-panel"
      aria-label="My queue"
      data-hidden={view !== "Queue" || undefined}
    >
      <div className="panel-bar">
        <strong>Queue</strong>
        <span>{availableQueue.length} available</span>
      </div>
      <div className="scroll">
        {mySlot === null ? (
          <p className="empty">Claim a team to build a private queue.</p>
        ) : queue.length === 0 ? (
          <p className="empty">
            Empty. Your first available queued player is your timeout pick.
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
                  className="item"
                  onClick={() => setSelectedId(player.id)}
                  aria-label={`Select ${player.name} from queue`}
                >
                  <strong>{player.name}</strong>
                  <small>
                    {positionsOf(player)} · {player.team}
                    {drafted.has(player.id) ? " · Drafted" : ""}
                  </small>
                </button>
                <div className="icons">
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
      </div>
    </section>
  );
  const rosterPanel = (
    <section
      className="panel roster-panel"
      aria-label="Roster"
      data-hidden={view !== "Roster" || undefined}
    >
      <div className="panel-bar">
        <label className="inline">
          <span className="sr-only">View team</span>
          <select
            aria-label="View team"
            value={viewedTeam}
            onChange={(event) => setRosterTeam(Number(event.target.value))}
          >
            {Array.from({ length: room.settings.teamCount }, (_, slot) => (
              <option key={slot} value={slot}>
                {slot + 1}. {managerName(slot)}
                {slot === mySlot ? " (you)" : ""}
              </option>
            ))}
          </select>
        </label>
        {mySlot !== null && viewedTeam !== mySlot && (
          <button onClick={() => setRosterTeam(mySlot)}>Mine</button>
        )}
      </div>
      <div className="scroll">
        <ul className="roster-list">
          {configured.map((slot, index) => {
            const player = playerMap.get(rosterAssignment[index] ?? -1);
            return (
              <li key={index}>
                <span className={`position pos-${slot}`}>{slot}</span>
                {player ? (
                  <button
                    className="item"
                    onClick={() => setSelectedId(player.id)}
                  >
                    <strong>{player.name}</strong>
                    <small>
                      {player.team} · {positionsOf(player)}
                    </small>
                  </button>
                ) : (
                  <span className="open-slot">Open</span>
                )}
              </li>
            );
          })}
        </ul>
        <details className="totals">
          <summary>Projected totals</summary>
          {categoryStats.map((stat) => {
            const total = rosterProjection(rosterPlayers, stat);
            return (
              <div className="stat-pair" key={stat}>
                <span>{stat}</span>
                <span>
                  {format(total.value, stat)}{" "}
                  <small>
                    {total.coverage}/{total.total}
                  </small>
                </span>
              </div>
            );
          })}
        </details>
      </div>
    </section>
  );
  const playersPanel = (
    <section
      className="panel players-panel"
      aria-label="Players"
      data-hidden={view !== "Players" || undefined}
    >
      <div className={`filters ${filtersOpen ? "open" : ""}`}>
        <input
          type="search"
          aria-label="Search players"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setLimit(100);
          }}
          placeholder={`Search ${filtered.length} players`}
        />
        <select
          aria-label="Position"
          value={position}
          onChange={(event) => setPosition(event.target.value)}
        >
          <option value="">All pos.</option>
          {slots
            .filter((slot) => !["UTIL", "BN"].includes(slot))
            .map((slot) => (
              <option key={slot}>{slot}</option>
            ))}
        </select>
        <button
          className="more-filters"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(!filtersOpen)}
        >
          {filtersOpen ? "Less" : "More"}
        </button>
        <div className="extra">
          <select
            aria-label="NBA team"
            value={team}
            onChange={(event) => setTeam(event.target.value)}
          >
            <option value="">All NBA teams</option>
            {[...new Set(players.map((player) => player.team))]
              .sort()
              .map((nba) => (
                <option key={nba}>{nba}</option>
              ))}
          </select>
          <select
            aria-label="Stats"
            value={perGame ? "game" : "total"}
            onChange={(event) => setPerGame(event.target.value === "game")}
          >
            <option value="game">Per game</option>
            <option value="total">Season totals</option>
          </select>
          <select
            aria-label="Sort by"
            value={rankMode ? "rank" : sort}
            onChange={(event) => {
              setRankMode(event.target.value === "rank");
              setAscending(false);
              if (event.target.value !== "rank")
                setSort(event.target.value as Stat | "FP");
            }}
          >
            <option value="rank">Sort: rank</option>
            {columns.map((stat) => (
              <option key={stat} value={stat}>
                Sort: {stat}
              </option>
            ))}
          </select>
          <label className="check">
            <input
              type="checkbox"
              checked={showDrafted}
              onChange={(event) => setShowDrafted(event.target.checked)}
            />
            Drafted
          </label>
        </div>
      </div>
      <div className="scroll table-scroll">
        <table className="player-table">
          <thead>
            <tr>
              <th
                aria-sort={
                  rankMode ? (ascending ? "descending" : "ascending") : "none"
                }
              >
                <button
                  title={`Timeout order: ${room.settings.fallback} per game`}
                  onClick={() => {
                    setRankMode(true);
                    setAscending(rankMode ? !ascending : false);
                  }}
                >
                  Rk{rankMode ? (ascending ? "↓" : "↑") : ""}
                </button>
              </th>
              <th>Player</th>
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
                      setAscending(sort === stat ? !ascending : stat === "TO");
                    }}
                  >
                    {stat}
                    {!rankMode && sort === stat ? (ascending ? "↑" : "↓") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, limit).map((player) => {
              const queued = room.queue.includes(player.id);
              return (
                <tr
                  key={player.id}
                  className={`${selectedId === player.id ? "selected" : ""} ${drafted.has(player.id) ? "taken" : ""}`}
                >
                  <td>{rank.get(player.id)}</td>
                  <td>
                    <div className="name-cell">
                      <button
                        className="queue-toggle"
                        aria-label={`${queued ? "Remove" : "Queue"} ${player.name}`}
                        aria-pressed={queued}
                        disabled={
                          mySlot === null ||
                          busy ||
                          !connected ||
                          drafted.has(player.id)
                        }
                        onClick={() => toggleQueue(player.id)}
                      >
                        {queued ? "✓" : "+"}
                      </button>
                      <button
                        className="item"
                        aria-label={`Select ${player.name}`}
                        aria-pressed={selectedId === player.id}
                        onClick={() => setSelectedId(player.id)}
                      >
                        <strong>{player.name}</strong>
                        <small>
                          {positionsOf(player)} · {player.team}
                          {injuryOf(player) && (
                            <em className="injury"> {injuryOf(player)}</em>
                          )}
                          {drafted.has(player.id) ? " · Drafted" : ""}
                        </small>
                      </button>
                    </div>
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
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="empty">No players match. Clear search or filters.</p>
        )}
        {filtered.length > limit && (
          <button className="more" onClick={() => setLimit(limit + 100)}>
            Show 100 more
          </button>
        )}
      </div>
    </section>
  );
  const boardPanel = (
    <section
      className="panel board-panel"
      aria-label="Draft board"
      data-hidden={view !== "Board" || undefined}
    >
      <div className="scroll board-scroll">
        <table>
          <thead>
            <tr>
              <th>Rd</th>
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
                        Math.floor(index / room.settings.teamCount) === round,
                    ),
                    pick = room.picks[index],
                    player = pick ? playerMap.get(pick.playerId) : null;
                  return (
                    <td
                      key={slot}
                      className={
                        index === currentIndex && room.phase !== "complete"
                          ? "current"
                          : player
                            ? `filled pos-${player.positions[0]}`
                            : ""
                      }
                    >
                      <small>{index + 1}</small>
                      <strong>
                        {player?.name ??
                          (index === currentIndex && !lobby ? "On clock" : "")}
                      </strong>
                      {player && (
                        <small>
                          {positionsOf(player)} · {player.team}
                          {pick.source !== "manual" ? ` · ${pick.source}` : ""}
                        </small>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
  const menu = (
    <details className="menu" ref={menuRef}>
      <summary aria-label="Room menu">☰</summary>
      <div className="menu-panel">
        {room.me ? (
          <>
            <strong>
              {mySlot === null
                ? "No team"
                : `${managerName(mySlot)} · Team ${mySlot + 1}`}
              {commissioner ? " · Commissioner" : ""}
            </strong>
            {recoveryCode && (
              <div className="code-row">
                <span>Recovery code</span>
                {showCode ? (
                  <code>{recoveryCode}</code>
                ) : (
                  <button onClick={() => setShowCode(true)}>Show</button>
                )}
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(recoveryCode);
                      setNotice("Recovery code copied");
                    } catch {
                      setShowCode(true);
                      setNotice("Select and copy the code.");
                    }
                  }}
                >
                  Copy
                </button>
              </div>
            )}
            {commissioner &&
              room.members.some((m) => !m.commissioner && m.slot !== null) && (
                <label className="inline">
                  <span>Hand off commissioner</span>
                  <select
                    aria-label="Hand off commissioner"
                    value=""
                    disabled={busy || !connected}
                    onChange={(event) =>
                      send(
                        { type: "transfer", slot: Number(event.target.value) },
                        "Commissioner handed off",
                      )
                    }
                  >
                    <option value="">Choose manager</option>
                    {room.members
                      .filter((m) => !m.commissioner && m.slot !== null)
                      .map((m) => (
                        <option key={m.slot} value={m.slot!}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
            {!commissioner && mySlot !== null && room.commissionerIdle && (
              <button
                disabled={busy || !connected}
                onClick={() =>
                  send({ type: "takeCommissioner" }, "You are now commissioner")
                }
              >
                Take over as commissioner
              </button>
            )}
            {confirmLeave ? (
              <div className="confirm">
                <span>
                  {lobby
                    ? "Release your team and leave?"
                    : "Leave? Your team keeps auto-picking. Anyone can claim it."}
                </span>
                <button
                  className="danger"
                  disabled={busy || !connected}
                  onClick={() => send({ type: "leave" }, "You left the room")}
                >
                  Leave room
                </button>
                <button onClick={() => setConfirmLeave(false)}>Stay</button>
              </div>
            ) : (
              <button onClick={() => setConfirmLeave(true)}>Leave room…</button>
            )}
            <div className="exports">
              {(["order", "picks", "rosters"] as const).map((kind) => (
                <a
                  className="button"
                  key={kind}
                  href={`/api/rooms/${id}/export?kind=${kind}`}
                >
                  {kind} CSV
                </a>
              ))}
            </div>
          </>
        ) : (
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
        )}
        <div className="data-info">
          <a
            href="https://fantasy.espn.com/basketball/players/projections"
            target="_blank"
            rel="noreferrer"
          >
            ESPN projections
          </a>{" "}
          · {info.season - 1}–{String(info.season).slice(-2)} · data version{" "}
          {info.dataset} · {info.projectedCount}/{players.length} projected ·
          updated {new Date(info.fetchedAt).toLocaleString()}
          {info.checkedAt &&
            ` · checked ${new Date(info.checkedAt).toLocaleString()}`}
          {info.warning && <p className="warn">{info.warning}</p>}
          {!lobby && <p>Frozen at start. ESPN outages do not affect picks.</p>}
          {commissioner && lobby && (
            <button
              disabled={busy || !connected}
              onClick={() => send({ type: "refresh" }, "ESPN refresh checked")}
            >
              Refresh ESPN data
            </button>
          )}
          <p>— means missing, not zero. Not affiliated with ESPN.</p>
        </div>
        <nav className="room-links" aria-label="Switch room">
          {otherRooms.map((other) => (
            <a key={other.id} href={`/room/${other.id}`}>
              {other.name} · {other.team}
            </a>
          ))}
          <a href="/">New or join room</a>
        </nav>
      </div>
    </details>
  );
  const alerts = [
    !connected && (
      <div role="alert" className="alert error" key="offline">
        <span>
          Offline · picks paused on this device. The server clock continues.
        </span>
        <button onClick={reconnect}>Reconnect</button>
      </div>
    ),
    error && (
      <div role="alert" className="alert error" key="error">
        <span>{error}</span>
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
        <button aria-label="Dismiss error" onClick={() => setError("")}>
          ×
        </button>
      </div>
    ),
    room.message && (
      <p className="alert warning" role="status" key="message">
        {room.message}
      </p>
    ),
    undo && (
      <div className="alert warning" key="undo">
        <span>
          Undo {undo.name} (pick {undo.index})? The room pauses with a full
          clock.
        </span>
        <button
          onClick={() => {
            send(
              {
                type: "undo",
                expectedIndex: undo.index,
                expectedPlayerId: undo.playerId,
                expectedVersion: undo.version,
              },
              "Latest pick undone",
            );
            setUndo(null);
          }}
        >
          Confirm undo
        </button>
        <button onClick={() => setUndo(null)}>Cancel</button>
      </div>
    ),
    recoveryCode && !showCode && room.me && lobby && (
      <div className="alert info" key="code">
        <span>
          Save your private recovery code to rejoin from another device.
        </span>
        <button onClick={() => setShowCode(true)}>Show code</button>
      </div>
    ),
    recoveryCode && showCode && lobby && (
      <div className="alert info" key="code-shown">
        <code>{recoveryCode}</code>
        <button
          onClick={() => {
            sessionStorage.removeItem(`recovery_${id}`);
            setRecoveryCode("");
            setShowCode(false);
          }}
        >
          Saved · hide
        </button>
      </div>
    ),
    !room.me && !lobby && openSlots.length > 0 && room.phase !== "complete" && (
      <div className="alert info" key="rejoin">
        <span>Open team:</span>
        {claimSlot === null
          ? openSlots.map((slot) => (
              <button key={slot} onClick={() => setClaimSlot(slot)}>
                Claim {managerName(slot)}
              </button>
            ))
          : claimForm(claimSlot)}
      </div>
    ),
  ].filter(Boolean);
  return (
    <div className="shell room">
      <header className="topbar">
        <div className="title">
          <strong>{room.name}</strong>
          <small>
            {room.settings.format === "3rr" ? "3RR" : "Snake"} ·{" "}
            {room.settings.teamCount} teams · {configured.length} rds
          </small>
        </div>
        <div
          className={`clock ${myTurn && room.phase === "live" ? "mine" : ""} ${room.phase}`}
          role="timer"
          aria-live="off"
        >
          <span>
            {room.phase === "complete"
              ? "Complete"
              : lobby
                ? "Ready"
                : `${room.phase === "paused" ? "Paused" : `R${Math.floor(currentIndex / room.settings.teamCount) + 1}.${(currentIndex % room.settings.teamCount) + 1}`} · ${myTurn ? "You" : managerName(currentSlot)}`}
          </span>
          <strong>
            {lobby
              ? `${readyCount}/${room.settings.teamCount}`
              : room.phase === "complete"
                ? "✓"
                : clock(remaining)}
          </strong>
        </div>
        <div className="status">
          <span className="next">
            {mySlot === null
              ? room.me
                ? "No team"
                : "Viewing"
              : nextIndex < 0
                ? "Done"
                : nextIndex === currentIndex && !lobby
                  ? "Your pick"
                  : `Next #${nextIndex + 1}`}
          </span>
          <span
            className={`dot ${connected ? "" : "off"}`}
            title={connected ? "Connected" : "Disconnected"}
            aria-label={connected ? "Connected" : "Disconnected"}
            role="img"
          />
          <span
            className={`data-badge ${dataStale ? "stale" : ""}`}
            title={
              info.warning ??
              `ESPN data updated ${new Date(info.fetchedAt).toLocaleString()}`
            }
          >
            ESPN {age(dataAge)}
          </span>
          {menu}
        </div>
      </header>
      {!lobby && (
        <ol className="pick-strip" aria-label="Recent and upcoming picks">
          {order
            .slice(
              Math.max(0, currentIndex - 3),
              Math.min(order.length, currentIndex + 6),
            )
            .map((slot, relative) => {
              const index = Math.max(0, currentIndex - 3) + relative,
                pick = room.picks[index],
                player = pick ? playerMap.get(pick.playerId) : null;
              return (
                <li key={index}>
                  <button
                    className={`${index === currentIndex ? "current" : pick ? "picked" : ""} ${slot === mySlot ? "mine" : ""}`}
                    onClick={() => showRoster(slot)}
                    aria-label={`Pick ${index + 1}, ${managerName(slot)}${player ? `, ${player.name}` : ""}`}
                  >
                    <small>
                      {index + 1} · {managerName(slot)}
                    </small>
                    <strong>
                      {player?.name ??
                        (index === currentIndex ? "On clock" : "—")}
                    </strong>
                  </button>
                </li>
              );
            })}
        </ol>
      )}
      {alerts.length > 0 && <div className="alerts">{alerts}</div>}
      <nav className="tabs" aria-label="Draft views">
        {tabs.map((name) => (
          <button
            key={name}
            className={`tab-${name.toLowerCase()}`}
            aria-current={view === name ? "page" : undefined}
            onClick={() => setTab(name)}
          >
            {name}
            {name === "Queue" ? ` ${availableQueue.length}` : ""}
          </button>
        ))}

        {commissioner && !lobby && (
          <span className="commish">
            <button
              disabled={busy || !connected || room.phase === "complete"}
              onClick={() =>
                send(
                  { type: room.phase === "paused" ? "resume" : "pause" },
                  room.phase === "paused" ? "Draft resumed" : "Draft paused",
                )
              }
            >
              {room.phase === "paused" ? "Resume" : "Pause"}
            </button>
            <button
              disabled={!room.picks.length || busy || !connected}
              onClick={() => {
                const pick = room.picks.at(-1)!;
                setUndo(
                  undo
                    ? null
                    : {
                        index: currentIndex,
                        playerId: pick.playerId,
                        version: room.version,
                        name:
                          playerMap.get(pick.playerId)?.name ??
                          String(pick.playerId),
                      },
                );
              }}
            >
              Undo
            </button>
            <label className="check">
              <input
                type="checkbox"
                checked={forTeam}
                onChange={(event) => setForTeam(event.target.checked)}
              />
              Pick for team on clock
            </label>
          </span>
        )}
      </nav>
      <main
        className={`workspace view-${view.toLowerCase()} ${lobby ? "is-lobby" : ""}`}
      >
        {lobby && lobbyPanel}
        {playersPanel}
        {boardPanel}
        {queuePanel}
        {rosterPanel}
        {settings && (
          <section className="panel sheet" aria-label="League settings">
            <div className="panel-bar">
              <strong>League settings</strong>
              <button onClick={() => setSettings(null)}>Cancel</button>
              <button
                className="primary"
                disabled={busy || !connected}
                onClick={() =>
                  send(
                    { type: "settings", settings },
                    "Settings saved; teams must mark ready again",
                  )
                }
              >
                Save
              </button>
            </div>
            <div className="scroll">
              <SettingsEditor settings={settings} onChange={setSettings} />
            </div>
          </section>
        )}
        {details && selected && (
          <section className="panel sheet" aria-label="Selected player details">
            <div className="panel-bar">
              <strong>{selected.name}</strong>
              <button onClick={() => setDetails(false)}>Close details</button>
            </div>
            <div className="scroll">
              <p>
                {selected.team} · {selected.positions.join(", ")}
                {injuryOf(selected) ? ` · ${injuryOf(selected)}` : ""} ·{" "}
                {selected.projected
                  ? `${info.season - 1}–${String(info.season).slice(-2)} ESPN projection`
                  : "No current ESPN projection"}
              </p>
              <div className="details-stats">
                {Object.keys(statIds).map((stat) => (
                  <div className="stat-pair" key={stat}>
                    <span>
                      {stat}
                      {selected.derived.includes(stat as Stat) ? "*" : ""}
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
                <p className="hint">
                  FP/game ={" "}
                  {Object.entries(room.settings.weights)
                    .filter(([, weight]) => !!weight)
                    .map(([stat, weight]) => `${stat}×${weight}`)
                    .join(" + ")}
                  . Missing:{" "}
                  {Object.entries(room.settings.weights)
                    .filter(
                      ([stat, weight]) =>
                        weight && selected.totals[stat as Stat] === null,
                    )
                    .map(([stat]) => stat)
                    .join(", ") || "none"}
                  . * derived from makes and attempts.
                </p>
              )}
              <button
                disabled={
                  mySlot === null ||
                  busy ||
                  !connected ||
                  drafted.has(selected.id)
                }
                onClick={() => toggleQueue(selected.id)}
              >
                {room.queue.includes(selected.id)
                  ? "Remove from queue"
                  : "Add to queue"}
              </button>
            </div>
          </section>
        )}
      </main>
      <footer className="actionbar">
        <button
          className="selection"
          disabled={!selected}
          onClick={() => setDetails(!details)}
          aria-label={
            selected
              ? `${details ? "Close" : "Open"} details for ${selected.name}`
              : "No player selected"
          }
        >
          {selected ? (
            <>
              <strong>{selected.name}</strong>
              <small>
                {positionsOf(selected)} · {selected.team} ·{" "}
                {drafted.has(selected.id)
                  ? "Drafted"
                  : !fits
                    ? "Cannot fit roster"
                    : myTurn || acting
                      ? lobby
                        ? "Fits roster"
                        : "Eligible now"
                      : "Fits roster"}
              </small>
            </>
          ) : (
            <>
              <strong>No player selected</strong>
              <small>
                {room.phase === "complete"
                  ? `${room.picks.length} picks saved · export from ☰`
                  : mySlot !== null && needs.length
                    ? `Needs ${[...new Set(needs)].join(" ")}`
                    : "Tap a name to select"}
              </small>
            </>
          )}
        </button>
        {notice && (
          <span role="status" className="notice">
            {notice}
          </span>
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
          {selected && room.phase !== "complete"
            ? `Draft ${selected.name}`
            : "Draft"}
        </button>
      </footer>
    </div>
  );
}

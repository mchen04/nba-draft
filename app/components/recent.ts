// Rooms this browser opened, newest first. Holds names only, never credentials.
export type RecentRoom = { id: string; name: string; team: string };
const key = "nba_recent_rooms";

export function recentRooms(): RecentRoom[] {
  try {
    const rooms = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(rooms) ? rooms : [];
  } catch {
    return [];
  }
}
function store(rooms: RecentRoom[]) {
  try {
    localStorage.setItem(key, JSON.stringify(rooms.slice(0, 8)));
  } catch {}
}
export function rememberRoom(room: RecentRoom) {
  store([
    room,
    ...recentRooms().filter((candidate) => candidate.id !== room.id),
  ]);
}
export function forgetRoom(id: string) {
  store(recentRooms().filter((room) => room.id !== id));
}
// Accept a full invite link or a bare room ID.
export function roomIdFrom(input: string) {
  const match = input
    .trim()
    .match(
      /(?:^|\/room\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i,
    );
  return match?.[1].toLowerCase() ?? null;
}

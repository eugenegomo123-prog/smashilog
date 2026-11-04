import type { Court, Match, Player } from "../api";

// Small helpers for the Live (host) / Home (player) screen. Pure functions, no
// network and no React -- they only reshape data the pages have already loaded.

// Players eligible to appear in a new suggestion or custom match: approved, active,
// and not already on a court or already sitting in the actual queue.
//
// (Moved here unchanged from HostSession.tsx so the player's Home screen can
// show the same "Waiting" number the host's matchmaking works from.)
export function eligiblePoolFor(players: Player[], ongoing: Match[], queued: Match[]): Player[] {
  const busy = new Set([...ongoing, ...queued].flatMap((m) => [...m.team1, ...m.team2]));
  return players.filter((p) => p.approved && p.status === "active" && !busy.has(p.id));
}

export interface CourtSlot {
  court: Court;
  match: Match | null;
}

// One slot per court, in the order the courts are listed, each holding the
// match currently on it (or null when it's open). `extra` is any ongoing match
// that no listed court claims -- it shouldn't happen, but if it ever does the
// match must still show up rather than silently disappear.
//
// A court is occupied when some ongoing match is linked to it by stable id;
// only a match from before courtId existed (null) falls back to matching by
// label. This is the same rule the host page used to decide "open" courts (and
// mirrors worker/lib/courts.ts's isCourtOccupied), just applied court by court.
export function courtSlots(courts: Court[], ongoing: Match[]): { slots: CourtSlot[]; extra: Match[] } {
  const claimed = new Set<number>();
  const slots = courts.map((court) => {
    const match =
      ongoing.find((m) => !claimed.has(m.id) && (m.courtId != null ? m.courtId === court.id : m.courtLabel === court.label)) ??
      null;
    if (match) claimed.add(match.id);
    return { court, match };
  });
  return { slots, extra: ongoing.filter((m) => !claimed.has(m.id)) };
}

// How long a match has been on court, kept short for a card corner:
// "just started", "14m", "1h 05m".
export function playTime(startedAt: string): string {
  const mins = Math.floor((Date.now() - new Date(startedAt).getTime()) / 60000);
  if (mins < 1) return "just started";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${String(mins % 60).padStart(2, "0")}m`;
}

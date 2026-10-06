// Court identity. A session's courts are stored as JSONB (sessions.courtLabels)
// -- an array of { id, label }. The id is a stable, server-generated identity,
// independent of the display label, so renaming a court (PATCH
// /sessions/:id/courts/:courtId in worker/index.ts) never breaks the link to
// a match already `ongoing` on it: that match tracks its court by
// matches.courtId, not by the label string. See the matching comment on
// db/schema.ts's sessions.courtLabels and matches.courtId.
export interface Court {
  id: string;
  label: string;
}

// Accepts whatever is actually stored for sessions.courtLabels and returns the
// current { id, label } shape, upgrading older rows that still hold the
// previous plain-string[] shape (every write path from here on emits objects
// only, so this is a one-time, lazy, read-time upgrade -- no separate
// migration script needed). The synthetic "court-<index>" id assigned to a
// legacy string is stable across repeated reads as long as the array's order
// doesn't change, which is exactly that old shape's only real identity
// anyway (position) -- no worse than before this change, strictly better
// once the row is next resized or renamed and the real shape gets saved.
export function normalizeCourts(raw: unknown): Court[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, i) => {
    if (typeof entry === "string") return { id: `court-${i}`, label: entry };
    if (entry && typeof entry === "object") {
      const id = (entry as { id?: unknown }).id;
      const label = (entry as { label?: unknown }).label;
      if (typeof id === "string" && typeof label === "string") return { id, label };
      if (typeof label === "string") return { id: `court-${i}`, label };
    }
    return { id: `court-${i}`, label: `Court #${i + 1}` };
  });
}

export function newCourtId(): string {
  return crypto.randomUUID();
}

// Resizes to exactly `count` courts, preserving each existing court's id and
// label by position and only generating a fresh id for a newly-added slot.
// Shrinking just truncates -- same as before this change.
export function resizeCourts(current: Court[], count: number): Court[] {
  const safeCount = Math.max(1, count);
  return Array.from({ length: safeCount }, (_, i) => current[i] ?? { id: newCourtId(), label: `Court #${i + 1}` });
}

// Is this court currently occupied by an ongoing match? Matches by the
// match's stable courtId; a match from before courtId existed (null, since
// the column defaults to null and nothing backfills it) falls back to
// matching the label it was assigned under. That fallback is only ever a
// one-time transitional case for whatever was already `ongoing` at the
// moment this change deployed -- every match created afterward gets a real
// courtId and is rename-safe from the start.
export function isCourtOccupied(
  court: Court,
  ongoingMatches: { courtId: string | null; courtLabel: string }[],
): boolean {
  return ongoingMatches.some((m) => (m.courtId != null ? m.courtId === court.id : m.courtLabel === court.label));
}

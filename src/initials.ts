// The one rule for turning a name into the letters shown on a no-photo avatar:
// the first letter of each of the first two words, capitalised ("Eugene G." ->
// "EG", "Ana" -> "A"), or "?" if there is no name at all. It is the same rule
// ParticipantSession.tsx's Avatar and accountAvatar.tsx use, and the Ranking
// tabs (rankAvatar.tsx) and the shared results image (shareImage.ts) use this
// function so a player's initials look the same everywhere.
//
// Works on whole characters (Array.from) rather than UTF-16 units, so a name
// that starts with an emoji doesn't end up with half a character on the circle.
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return words.map((word) => (Array.from(word)[0] ?? "").toUpperCase()).join("") || "?";
}

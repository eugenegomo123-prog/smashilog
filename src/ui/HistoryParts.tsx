import { useId, useState, type ReactNode } from "react";
import type { Match, Player } from "../api";
import { Icon } from "./Icon";

// A finished match as a compact card that opens up when tapped.
//
// Closed, it shows the result at a glance: the score (winner's number first,
// in green), the winning pair, who they beat, and when. Open, it shows both
// teams with their scores plus the court and full date -- and whatever extra
// the page passes in (the host's Edit / Delete buttons).
//
// It only changes how a match is *shown*. Nothing here fetches or saves
// anything; the host page still does all of that itself.

type Lookup = (id: number) => Player | undefined;

function names(ids: number[], playerById: Lookup) {
  return ids.map((id) => playerById(id)?.name ?? "?").join(" & ");
}

// "2:35 PM" for today, "12 Jul, 2:35 PM" for anything older -- much shorter
// than the full toLocaleString() date the cards used to print.
function shortWhen(iso: string) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

export function HistoryItem({
  match,
  playerById,
  focusId,
  forceOpen,
  scoreSlot1,
  scoreSlot2,
  footer,
}: {
  match: Match;
  playerById: Lookup;
  // The player whose point of view this is (the signed-in player, or the one
  // whose matches are being browsed). Adds a Won / Lost tag and bolds their pair.
  focusId?: number | null;
  // Keeps the card open (the host's card while a score is being edited).
  forceOpen?: boolean;
  // Replace a team's score in the open card (the host's edit boxes).
  scoreSlot1?: ReactNode;
  scoreSlot2?: ReactNode;
  // Extra content under the teams (host buttons and error text).
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const shown = open || !!forceOpen;

  const { score1, score2 } = match;
  const known = score1 !== null && score2 !== null;
  const winner: 0 | 1 | 2 = known && score1 !== score2 ? (score1 > score2 ? 1 : 2) : 0;
  const t1 = names(match.team1, playerById);
  const t2 = names(match.team2, playerById);

  // Winners first. A tie (or a missing score) keeps team 1 first.
  const first = winner === 2 ? 2 : 1;
  const firstNames = first === 1 ? t1 : t2;
  const secondNames = first === 1 ? t2 : t1;
  const firstScore = first === 1 ? score1 : score2;
  const secondScore = first === 1 ? score2 : score1;
  const sub = winner ? `beat ${secondNames}` : `vs ${secondNames}`;

  const mine: 0 | 1 | 2 =
    focusId == null ? 0 : match.team1.includes(focusId) ? 1 : match.team2.includes(focusId) ? 2 : 0;
  const result = mine && known ? (winner === 0 ? "tied" : winner === mine ? "won" : "lost") : null;

  const when = match.endedAt ?? match.startedAt;
  const scoreWord = (n: number | null) => (n === null ? "no score" : String(n));

  return (
    <div className={`hist${shown ? " open" : ""}${result ? ` ${result}` : ""}`}>
      <button
        type="button"
        className="hist-head"
        aria-expanded={shown}
        aria-controls={shown ? bodyId : undefined}
        onClick={() => setOpen(!open)}
      >
        <span className="hist-score" aria-hidden="true">
          {known ? (
            <>
              <b className={winner ? "w" : undefined}>{firstScore}</b>
              <i>–</i>
              <b>{secondScore}</b>
            </>
          ) : (
            <b>–</b>
          )}
        </span>
        <span className="hist-main">
          <span className="hist-title">{firstNames}</span>
          <span className="hist-sub">{sub}</span>
          <span className="hist-meta">
            {result && <span className={`hist-res ${result}`}>{result === "won" ? "Won" : result === "lost" ? "Lost" : "Tied"}</span>}
            {match.courtLabel && <span>{match.courtLabel}</span>}
            <span>{shortWhen(when)}</span>
          </span>
        </span>
        <Icon name="chevron-down" size={20} className="hist-chev" />
        <span className="sr-only">
          Score {scoreWord(firstScore)} to {scoreWord(secondScore)}.
        </span>
      </button>

      {shown && (
        <div className="hist-body" id={bodyId}>
          <div className="court-label">
            {match.courtLabel} · {new Date(when).toLocaleString()}
          </div>
          <div className={`hist-team${winner === 1 ? " win" : ""}${mine === 1 ? " mine" : ""}`}>
            <span className="hist-names">{t1}</span>
            {scoreSlot1 ?? <strong>{score1}</strong>}
          </div>
          <div className={`hist-team${winner === 2 ? " win" : ""}${mine === 2 ? " mine" : ""}`}>
            <span className="hist-names">{t2}</span>
            {scoreSlot2 ?? <strong>{score2}</strong>}
          </div>
          {footer}
        </div>
      )}
    </div>
  );
}

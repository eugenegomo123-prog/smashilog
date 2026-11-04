import type { Match, Player } from "../api";
import { Icon } from "./Icon";

// A small preview of the first match in the queue, for the bottom of the Live
// (host) / Home (player) screen, with a button across to the full Queue tab.
// It only reads what the page already loaded -- no extra requests.
//
// `myId` is the signed-in player (player page only): if they're in this match
// the card says so.
export function NextUp({
  queued,
  playerById,
  onOpenQueue,
  myId,
}: {
  queued: Match[];
  playerById: (id: number) => Player | undefined;
  onOpenQueue: () => void;
  myId?: number | null;
}) {
  const next = queued[0];
  const more = queued.length - 1;
  const name = (id: number) => playerById(id)?.name ?? "?";
  const mine = !!next && myId != null && [...next.team1, ...next.team2].includes(myId);

  return (
    <section className="next-up" aria-label="Next up">
      <div className="row between next-up-head">
        <span className="section-title">Next up</span>
        <button type="button" className="link-btn" onClick={onOpenQueue}>
          View queue
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
      {next ? (
        <div className={mine ? "match-card next-card mine" : "match-card next-card"}>
          {mine && <div className="you-chip">You're up next</div>}
          <div className="next-teams">
            <div className="next-team">
              {next.team1.map((id) => (
                <span key={id}>{name(id)}</span>
              ))}
            </div>
            <span className="next-vs" aria-hidden="true">
              VS
            </span>
            <div className="next-team right">
              {next.team2.map((id) => (
                <span key={id}>{name(id)}</span>
              ))}
            </div>
          </div>
          {more > 0 && (
            <div className="caption-xs next-more">
              +{more} more {more === 1 ? "match" : "matches"} in the queue
            </div>
          )}
        </div>
      ) : (
        <div className="match-card next-card empty">No matches queued yet.</div>
      )}
    </section>
  );
}

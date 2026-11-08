import { liveCourtLabel, type Court, type Match, type Player } from "../api";
import { Icon } from "./Icon";
import { joinLabels, matchesStillBlocking } from "./live";

// How many matches to list under the first one while Auto queue is on.
const THEN_ROWS = 2;

// A small preview of the first match in the queue, for the bottom of the Live
// (host) / Home (player) screen, with a button across to the full Queue tab.
// It only reads what the page already loaded -- no extra requests.
//
// `myId` is the signed-in player (player page only): if they're in this match
// the card says so.
//
// The last three props are the look-ahead (all optional, so a page that leaves
// them out gets the plain card):
//   ongoing + courtLabels: lets the card say which court the first match is
//     waiting for, when one of its players is still playing there;
//   auto: Auto queue is on, so also list the next couple of matches after the
//     first, not just a count.
export function NextUp({
  queued,
  playerById,
  onOpenQueue,
  myId,
  ongoing,
  courtLabels,
  auto,
}: {
  queued: Match[];
  playerById: (id: number) => Player | undefined;
  onOpenQueue: () => void;
  myId?: number | null;
  ongoing?: Match[];
  courtLabels?: Court[];
  auto?: boolean;
}) {
  const next = queued[0];
  const then = auto ? queued.slice(1, 1 + THEN_ROWS) : [];
  const more = queued.length - 1 - then.length;
  const name = (id: number) => playerById(id)?.name ?? "?";
  const mine = !!next && myId != null && [...next.team1, ...next.team2].includes(myId);
  const waitingFor =
    next && ongoing && courtLabels ? matchesStillBlocking(next, ongoing).map((m) => liveCourtLabel(courtLabels, m)) : [];

  // "Mia & Joe", with the signed-in player's own name picked out.
  const teamNames = (ids: number[]) => (
    <span className="next-then-team">
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && " & "}
          <span className={id === myId ? "next-name me" : "next-name"}>{name(id)}</span>
        </span>
      ))}
    </span>
  );

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
          {waitingFor.length > 0 && (
            <div className="caption-xs next-wait">Waiting for {joinLabels(waitingFor)} to finish</div>
          )}
          {then.length > 0 && (
            <ol className="next-then" aria-label="After that">
              {then.map((m, i) => {
                const rowMine = myId != null && [...m.team1, ...m.team2].includes(myId);
                return (
                  <li key={m.id} className={rowMine ? "next-then-row mine" : "next-then-row"}>
                    <span className="next-then-num">{i + 2}</span>
                    <span className="next-then-names">
                      {teamNames(m.team1)} <span className="next-then-vs">vs</span> {teamNames(m.team2)}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
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

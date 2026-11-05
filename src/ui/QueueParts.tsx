import type { ReactNode } from "react";
import { LEVEL_ICON, type Player } from "../api";
import { Icon } from "./Icon";
import { VsDivider } from "./CourtParts";

// Pieces of the Queue tab, shared by the host's page and the player's page so
// the two read the same. They only draw what the page hands them -- nothing
// here changes the queue or talks to the server.

// One player's name as it appears in a match line.
//   detail: the host's extra markers -- 🏆/😎 (competitive/chill) in front and
//   🥵 (just played) / ⏳ (waiting a while) after, same as the host always had.
function PlayerName({
  player,
  id,
  detail,
  justPlayed,
  restingLong,
  myId,
}: {
  player: Player | undefined;
  id: number;
  detail?: boolean;
  justPlayed?: Set<number>;
  restingLong?: Set<number>;
  myId?: number | null;
}) {
  const name = player?.name ?? "?";
  const level = player ? LEVEL_ICON[player.level] : "";
  const mode = detail ? `${player?.playingMode === "chill" ? "😎" : "🏆"} ` : "";
  const flags = detail ? `${justPlayed?.has(id) ? " 🥵" : ""}${restingLong?.has(id) ? " ⏳" : ""}` : "";
  return (
    <span className={id === myId ? "queue-player me" : "queue-player"}>
      {mode}
      {level} {name}
      {flags}
    </span>
  );
}

// Team 1, a VS line, Team 2. A team's two names sit side by side and wrap onto
// a second line if they don't fit, rather than being cut off.
export function QueueTeams({
  team1,
  team2,
  playerById,
  detail,
  justPlayed,
  restingLong,
  myId,
}: {
  team1: number[];
  team2: number[];
  playerById: (id: number) => Player | undefined;
  detail?: boolean;
  justPlayed?: Set<number>;
  restingLong?: Set<number>;
  myId?: number | null;
}) {
  const team = (ids: number[]) => (
    <div className="queue-team">
      {ids.map((id, i) => (
        <span key={id} className="queue-team-member">
          {i > 0 && <span className="queue-amp">&amp;</span>}
          <PlayerName
            player={playerById(id)}
            id={id}
            detail={detail}
            justPlayed={justPlayed}
            restingLong={restingLong}
            myId={myId}
          />
        </span>
      ))}
    </div>
  );
  return (
    <div className="queue-teams">
      {team(team1)}
      <VsDivider />
      {team(team2)}
    </div>
  );
}

// One match in the queue. The first one (`hero`) is the "next four": the four
// players who take the next court that opens up, drawn bigger and in yellow.
// The rest are numbered rows. `head` is for something on the right of the
// title line (a "You" tag), `actions` for the row of buttons underneath.
export function QueueMatchCard({
  n,
  hero,
  className = "match-card",
  mine,
  head,
  children,
  actions,
}: {
  n: number;
  hero?: boolean;
  className?: string;
  mine?: boolean;
  head?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const cls = [className, "queue-card", hero && "hero", mine && "mine"].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <div className="queue-head">
        <span className="queue-num">{n}</span>
        <span className="queue-title">{hero ? "Next four" : `Up #${n}`}</span>
        {hero && <Icon name="bolt" size={14} className="queue-bolt" />}
        {head}
      </div>
      {children}
      {actions}
    </div>
  );
}

// The players who are ready to play but aren't in a match yet, as little pills.
// `myId` lights up the signed-in player's own pill.
export function WaitingChips({
  players,
  justPlayed,
  restingLong,
  myId,
}: {
  players: Player[];
  justPlayed?: Set<number>;
  restingLong?: Set<number>;
  myId?: number | null;
}) {
  if (players.length === 0) {
    return <div className="caption">Nobody is waiting — everyone available is on a court or in the queue.</div>;
  }
  // Fewest games first (they're the ones matchmaking picks first), then A-Z.
  const sorted = [...players].sort((a, b) => a.gamesPlayed - b.gamesPlayed || a.name.localeCompare(b.name));
  return (
    <ul className="chips" aria-label="Waiting players">
      {sorted.map((p) => (
        <li key={p.id} className={p.id === myId ? "chip me" : "chip"}>
          <span aria-hidden="true">{LEVEL_ICON[p.level]}</span>
          {p.name}
          {restingLong?.has(p.id) && (
            <span className="chip-flag" title="Waiting a while" aria-label="waiting a while">
              ⏳
            </span>
          )}
          {justPlayed?.has(p.id) && (
            <span className="chip-flag" title="Just played" aria-label="just played">
              🥵
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

import type { ReactNode } from "react";
import { CountUp } from "./CountUp";
import { Icon, type IconName } from "./Icon";

function Tile({ icon, label, children, accent }: { icon: IconName; label: string; children: ReactNode; accent?: boolean }) {
  return (
    <div className={accent ? "stat-tile accent" : "stat-tile"}>
      <Icon name={icon} size={18} />
      <div className="stat-num">{children}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

// The three numbers at the top of the Live (host) / Home (player) screen:
// how many people are in the session, how many courts are in play out of the
// total, and how many players are waiting for a match. "Waiting" is worked out
// by the caller with the same rule matchmaking uses (see eligiblePoolFor in
// ./live.ts): approved, active, and not already on a court or in the queue.
export function StatTiles({
  players,
  courtsInPlay,
  courtCount,
  waiting,
}: {
  players: number;
  courtsInPlay: number;
  courtCount: number;
  waiting: number;
}) {
  return (
    <div className="stat-tiles" role="group" aria-label="Session at a glance">
      <Tile icon="users" label="Players">
        <CountUp value={players} />
      </Tile>
      <Tile icon="court" label="Courts" accent>
        <CountUp value={courtsInPlay} />
        <span className="stat-of">/{courtCount}</span>
      </Tile>
      <Tile icon="hourglass" label="Waiting">
        <CountUp value={waiting} />
      </Tile>
    </div>
  );
}

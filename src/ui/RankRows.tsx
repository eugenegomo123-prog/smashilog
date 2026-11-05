import type { ReactNode } from "react";
import { Link } from "react-router-dom";

// One row of a leaderboard (a Ranking tab, from 4th place down): position,
// picture, name with a line of detail under it, and win % with the average
// point difference on the right. The whole row is the tap target -- a button
// that opens the player's session matches, or a link to their profile.
//
// It replaces the wide table the Ranking tabs used to have, which needed
// sideways scrolling on a phone. `isMe` lights the row up green with a "You"
// tag so the signed-in player can find themselves at a glance.
export function RankRow({
  rank,
  avatar,
  name,
  nameExtra,
  sub,
  winPct,
  avgDiff,
  isMe,
  to,
  onClick,
}: {
  rank: number;
  avatar: ReactNode;
  name: string;
  nameExtra?: ReactNode;
  sub: ReactNode;
  winPct: number;
  avgDiff: number;
  isMe?: boolean;
  to?: string;
  onClick?: () => void;
}) {
  const diffLabel = avgDiff > 0 ? `+${avgDiff.toFixed(1)}` : avgDiff.toFixed(1);
  const diffColor = avgDiff > 0 ? "var(--good)" : avgDiff < 0 ? "var(--bad)" : "var(--muted)";
  const cls = isMe ? "rank-row me" : "rank-row";
  const body = (
    <>
      <span className="rank-pos">{rank}</span>
      <span className="rank-ava">{avatar}</span>
      <span className="rank-main">
        <span className="rank-name">
          <span className="rank-name-text">{name}</span>
          {nameExtra}
          {isMe && <span className="you-chip sm">You</span>}
        </span>
        <span className="rank-sub">{sub}</span>
      </span>
      <span className="rank-stat">
        <span className="rank-pct">{winPct}%</span>
        <span className="rank-diff" style={{ color: diffColor }} title="Average point difference per game">
          {diffLabel}
        </span>
      </span>
    </>
  );
  return to ? (
    <Link className={cls} to={to}>
      {body}
    </Link>
  ) : (
    <button type="button" className={cls} onClick={onClick}>
      {body}
    </button>
  );
}

// The small heading line above the rows.
export function RankLegend() {
  return (
    <div className="rank-legend" aria-hidden="true">
      <span>Player</span>
      <span>Win % · Avg diff</span>
    </div>
  );
}

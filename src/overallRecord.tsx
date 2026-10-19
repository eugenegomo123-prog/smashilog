// Same shape as api.ts's getOverallStats()/getAccountProfile() "stats"
// responses -- cross-session career numbers, as opposed to one session's
// Ranking tab (which only covers that session).
export interface OverallRecordStats {
  sessionsPlayed: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  pointsFor: number;
  pointsAgainst: number;
  averagePointDiff: number;
  highestWinStreak: number;
}

// The "Overall record" card: shown on a player's own Stats tab
// (PlayerHome.tsx) and, identically, on another member's public profile
// (PlayerProfile.tsx) -- same numbers, same card, so it only needs building
// (and improving) once. Leads with the win/loss split as the one thing
// anyone glances at first -- a big win-rate number plus a two-tone bar that
// actually encodes the split, not just decorates it -- then the remaining
// career numbers as a scannable 2x2 grid instead of a stack of thin rows.
export function OverallRecordCard({ stats }: { stats: OverallRecordStats }) {
  const winPct = stats.gamesPlayed > 0 ? Math.round((stats.wins / stats.gamesPlayed) * 100) : 0;
  const diffPositive = stats.averagePointDiff > 0;
  const diffNegative = stats.averagePointDiff < 0;

  return (
    <div className="card overall-record">
      <div className="overall-record-head">
        <div>
          <div className="overall-record-pct">{winPct}%</div>
          <div className="overall-record-pct-label">Win rate</div>
        </div>
        <div className="overall-record-wl">
          {stats.wins}
          <span>–</span>
          {stats.losses}
        </div>
      </div>

      {stats.gamesPlayed > 0 && (
        <div className="overall-record-bar" aria-hidden="true">
          <span style={{ width: `${winPct}%` }} />
        </div>
      )}

      <div className="overall-record-grid">
        <div className="overall-record-tile">
          <div className="overall-record-tile-value">{stats.sessionsPlayed}</div>
          <div className="overall-record-tile-label">Sessions played</div>
        </div>
        <div className="overall-record-tile">
          <div className="overall-record-tile-value">{stats.gamesPlayed}</div>
          <div className="overall-record-tile-label">Games played</div>
        </div>
        <div className="overall-record-tile">
          <div
            className="overall-record-tile-value"
            style={{ color: diffPositive ? "var(--good)" : diffNegative ? "var(--bad)" : undefined }}
          >
            {diffPositive ? `+${stats.averagePointDiff.toFixed(1)}` : stats.averagePointDiff.toFixed(1)}
          </div>
          <div className="overall-record-tile-label">Avg point diff</div>
        </div>
        <div className="overall-record-tile">
          <div className="overall-record-tile-value">
            {stats.highestWinStreak > 0 ? `🔥 ${stats.highestWinStreak}` : stats.highestWinStreak}
          </div>
          <div className="overall-record-tile-label">Best win streak</div>
        </div>
      </div>
    </div>
  );
}

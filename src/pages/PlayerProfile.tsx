import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, TIER_BADGE_IMAGE } from "../api";

// Same shape as api.ts's getAccountProfile() response -- kept here rather
// than exported from api.ts since nothing else needs it yet.
interface AccountProfile {
  username: string;
  stats: {
    sessionsPlayed: number;
    gamesPlayed: number;
    wins: number;
    losses: number;
    pointsFor: number;
    pointsAgainst: number;
    averagePointDiff: number;
    highestWinStreak: number;
  };
  rating: {
    tier: string;
    division: "I" | "II" | "III" | null;
    provisional: boolean;
    seasonPoints: number;
    ratedGamesPlayed: number;
    currentRatingStreak: number;
    provisionalGamesThreshold: number;
  };
}

// Read-only view of another club member's public profile -- reached by
// clicking a name on PlayerHome's Ranking tab. Shows the same rank badge and
// overall-record numbers that page already shows for "me", just for someone
// else: no rank-up banner (that's personal) and no account actions.
export default function PlayerProfile() {
  const { id } = useParams();
  const accountId = Number(id);
  const navigate = useNavigate();
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!api.isPlayerLoggedIn()) {
      navigate("/login");
      return;
    }
    api
      .getAccountProfile(accountId)
      .then(setProfile)
      .catch(() => setProfile(null))
      .finally(() => setLoaded(true));
  }, [accountId]);

  if (!api.isPlayerLoggedIn()) return null;

  return (
    <div className="screen">
      <Link className="back-link" to="/me">
        ← Back
      </Link>

      {!loaded && <div className="empty-state">Loading…</div>}
      {loaded && !profile && <div className="empty-state">Couldn't find that player.</div>}

      {profile && (
        <>
          <div className="brand">
            <h1>{profile.username}</h1>
          </div>

          <div className="rank-badge-card">
            <img
              className="rank-badge-image"
              src={TIER_BADGE_IMAGE[profile.rating.tier] ?? TIER_BADGE_IMAGE.Fledgling}
              alt={`${profile.rating.tier} rank badge`}
            />
            <div style={{ fontWeight: 800, fontSize: 26, color: "#fff", marginTop: 14 }}>
              {profile.rating.tier}
              {profile.rating.division ? ` ${profile.rating.division}` : ""}
            </div>
            {profile.rating.provisional && (
              <div style={{ fontSize: 13, color: "#d8cdbe", marginTop: 4 }}>
                {profile.rating.ratedGamesPlayed < profile.rating.provisionalGamesThreshold
                  ? `Still calibrating — ${profile.rating.ratedGamesPlayed} of ${profile.rating.provisionalGamesThreshold} rated games played`
                  : "Recalibrating after some time away"}
              </div>
            )}
            {profile.rating.currentRatingStreak >= 3 && (
              <div style={{ fontSize: 14, marginTop: 10, color: "#ffd27a" }}>
                🔥 {profile.rating.currentRatingStreak} win streak
              </div>
            )}
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 8 }}>Overall record</div>
            <div className="row between" style={{ marginBottom: 6 }}>
              <span>Sessions played</span>
              <strong>{profile.stats.sessionsPlayed}</strong>
            </div>
            <div className="row between" style={{ marginBottom: 6 }}>
              <span>Games played</span>
              <strong>{profile.stats.gamesPlayed}</strong>
            </div>
            <div className="row between" style={{ marginBottom: 6 }}>
              <span>Wins - Losses</span>
              <strong>
                {profile.stats.wins}-{profile.stats.losses}
                {profile.stats.gamesPlayed > 0
                  ? ` (${Math.round((profile.stats.wins / profile.stats.gamesPlayed) * 100)}%)`
                  : ""}
              </strong>
            </div>
            <div className="row between" style={{ marginBottom: 6 }}>
              <span>Average point diff</span>
              <strong
                style={{
                  color:
                    profile.stats.averagePointDiff > 0
                      ? "var(--good)"
                      : profile.stats.averagePointDiff < 0
                        ? "var(--bad)"
                        : "var(--muted)",
                }}
              >
                {profile.stats.averagePointDiff > 0
                  ? `+${profile.stats.averagePointDiff.toFixed(1)}`
                  : profile.stats.averagePointDiff.toFixed(1)}
              </strong>
            </div>
            <div className="row between">
              <span>Highest win streak</span>
              <strong>{profile.stats.highestWinStreak}</strong>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { RecordRow, OpponentLevelStrip, type PartnerStatsData } from "../partnerStats";

// The full partner/opponent breakdown -- reached from the "Show all" link on
// PlayerHome's Stats tab, once there are more than a handful of partners or
// head-to-head opponents to show. Kept as its own page/route (rather than an
// inline expand) so that preview stays short regardless of how many sessions
// someone's played.
export default function PartnerStatsPage() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<PartnerStatsData | null>(null);

  useEffect(() => {
    if (!api.isPlayerLoggedIn()) {
      navigate("/login");
      return;
    }
    api.getPartnerStats().then(setStats);
  }, []);

  if (!api.isPlayerLoggedIn()) return null;

  const empty = stats && stats.partners.length === 0 && stats.opponentLevels.length === 0 && stats.headToHead.length === 0;

  return (
    <div className="screen">
      <Link className="back-link" to="/me">
        ← Back
      </Link>
      <div className="brand">
        <h1>Partner &amp; opponent stats</h1>
      </div>

      {stats === null && <div className="empty-state">Loading…</div>}
      {empty && <div className="empty-state">No completed matches yet.</div>}

      {stats && !empty && (
        <div className="stack">
          {stats.partners.length > 0 && (
            <div>
              <h3 style={{ fontSize: 15, color: "var(--muted)" }}>Win rate by partner</h3>
              <div className="stack">
                {stats.partners.map((p) => (
                  <RecordRow key={p.name} label={p.name} wins={p.wins} losses={p.losses} gamesPlayed={p.gamesPlayed} />
                ))}
              </div>
            </div>
          )}

          <OpponentLevelStrip opponentLevels={stats.opponentLevels} />

          {stats.headToHead.length > 0 && (
            <div>
              <h3 style={{ fontSize: 15, color: "var(--muted)" }}>Head-to-head records</h3>
              <div className="stack">
                {stats.headToHead.map((h) => (
                  <RecordRow key={h.name} label={h.name} wins={h.wins} losses={h.losses} gamesPlayed={h.gamesPlayed} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

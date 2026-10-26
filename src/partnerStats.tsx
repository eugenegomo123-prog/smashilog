import { Link } from "react-router-dom";
import { LEVEL_ICON, LEVEL_LABEL, type Level } from "./api";

// Same shape as api.ts's getPartnerStats() response -- kept here (rather
// than imported from api.ts) the same way overallRecord.tsx keeps its own
// copy of getOverallStats()'s shape, since this is the shared module both
// PlayerHome.tsx's Stats-tab preview and the full PartnerStatsPage build on.
export interface PartnerRecord {
  name: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
}

export interface OpponentLevelRecord {
  level: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
}

export interface HeadToHeadRecord {
  name: string;
  gamesPlayed: number;
  wins: number;
  losses: number;
}

export interface PartnerStatsData {
  partners: PartnerRecord[];
  opponentLevels: OpponentLevelRecord[];
  headToHead: HeadToHeadRecord[];
}

export function winRatePct(wins: number, gamesPlayed: number): number {
  return gamesPlayed > 0 ? Math.round((wins / gamesPlayed) * 100) : 0;
}

// Below this many games together, one lucky or unlucky session can swing a
// partner's win rate wildly, so "most successful" only picks among partners
// who've cleared this bar -- falling back to the full list only if nobody
// has (e.g. every partnership is still brand new).
const MIN_GAMES_FOR_MOST_SUCCESSFUL_PARTNER = 3;

export function mostSuccessfulPartner<T extends { name: string; wins: number; gamesPlayed: number }>(
  partners: T[],
): T | null {
  if (partners.length === 0) return null;
  const qualified = partners.filter((p) => p.gamesPlayed >= MIN_GAMES_FOR_MOST_SUCCESSFUL_PARTNER);
  const pool = qualified.length > 0 ? qualified : partners;
  return [...pool].sort((a, b) => {
    const pctDiff = winRatePct(b.wins, b.gamesPlayed) - winRatePct(a.wins, a.gamesPlayed);
    if (pctDiff !== 0) return pctDiff;
    if (b.gamesPlayed !== a.gamesPlayed) return b.gamesPlayed - a.gamesPlayed;
    return a.name.localeCompare(b.name);
  })[0];
}

// A single "name · W-L in N games" row with a win-rate figure on the right --
// one row of the Win-rate-by-partner and Head-to-head lists, both in the
// Stats-tab preview and on the full PartnerStatsPage.
export function RecordRow({
  label,
  wins,
  losses,
  gamesPlayed,
}: {
  label: string;
  wins: number;
  losses: number;
  gamesPlayed: number;
}) {
  const pct = winRatePct(wins, gamesPlayed);
  return (
    <div className="card row between">
      <div>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {wins}-{losses} · {gamesPlayed} game{gamesPlayed === 1 ? "" : "s"}
        </div>
      </div>
      <div style={{ fontWeight: 700, color: pct >= 50 ? "var(--good)" : "var(--bad)" }}>{pct}%</div>
    </div>
  );
}

// Compact strip of tiles, one per opponent level actually faced (A-E, so at
// most 5) -- unlike partners/headToHead this never needs truncating, so it's
// shown in full both in the Stats-tab preview and on the full page, just as
// this one compact block. A real CSS grid with a fixed column count (rather
// than flex-wrap) so every tile is the same size and lines up in one neat
// row regardless of how many levels have been faced; plain divs rather than
// .card, both because .card's 16px padding is too heavy for a tile this
// narrow and because ".card + .card" adds a top margin between adjacent
// cards that (meant for a vertical stack) misaligned these when they sat
// side by side in a row.
export function OpponentLevelStrip({ opponentLevels }: { opponentLevels: OpponentLevelRecord[] }) {
  if (opponentLevels.length === 0) return null;
  return (
    <div>
      <h3 style={{ fontSize: 15, color: "var(--muted)" }}>Performance vs. opponent level</h3>
      <div className="level-stat-grid" style={{ gridTemplateColumns: `repeat(${opponentLevels.length}, 1fr)` }}>
        {opponentLevels.map((o) => {
          const pct = winRatePct(o.wins, o.gamesPlayed);
          return (
            <div key={o.level} className="level-stat-tile">
              <div className="level-stat-icon" title={LEVEL_LABEL[o.level as Level]}>
                {LEVEL_ICON[o.level as Level]}
              </div>
              <div className="level-stat-label">{o.level}</div>
              <div className="level-stat-pct" style={{ color: pct >= 50 ? "var(--good)" : "var(--bad)" }}>
                {pct}%
              </div>
              <div className="level-stat-games">
                {o.gamesPlayed} game{o.gamesPlayed === 1 ? "" : "s"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// How many partner/head-to-head rows the Stats-tab preview shows before
// handing off to the full page ("Show all") -- keeps the always-visible tab
// about as long as it was before this feature existed.
const PREVIEW_COUNT = 3;

// The preview shown inline on PlayerHome's Stats tab: the most-successful-
// partner highlight, the opponent-level strip in full (it's short), and only
// the top 3 of the two lists that can otherwise grow unbounded, with a link
// to PartnerStatsPage for the rest.
export function PartnerStatsPreview({ stats }: { stats: PartnerStatsData }) {
  const { partners, opponentLevels, headToHead } = stats;
  if (partners.length === 0 && opponentLevels.length === 0 && headToHead.length === 0) return null;

  const topPartner = mostSuccessfulPartner(partners);
  const hasMore = partners.length > PREVIEW_COUNT || headToHead.length > PREVIEW_COUNT;

  return (
    <div className="stack">
      {topPartner && (
        <div className="card">
          <div style={{ fontSize: 13, color: "var(--muted)" }}>Most successful partner</div>
          <div style={{ fontWeight: 700, fontSize: 18, marginTop: 2 }}>{topPartner.name}</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 2 }}>
            {winRatePct(topPartner.wins, topPartner.gamesPlayed)}% win rate · {topPartner.wins}-{topPartner.losses}{" "}
            together in {topPartner.gamesPlayed} game{topPartner.gamesPlayed === 1 ? "" : "s"}
          </div>
        </div>
      )}

      {partners.length > 0 && (
        <div>
          <h3 style={{ fontSize: 15, color: "var(--muted)" }}>Win rate by partner</h3>
          <div className="stack">
            {partners.slice(0, PREVIEW_COUNT).map((p) => (
              <RecordRow key={p.name} label={p.name} wins={p.wins} losses={p.losses} gamesPlayed={p.gamesPlayed} />
            ))}
          </div>
        </div>
      )}

      <OpponentLevelStrip opponentLevels={opponentLevels} />

      {headToHead.length > 0 && (
        <div>
          <h3 style={{ fontSize: 15, color: "var(--muted)" }}>Head-to-head records</h3>
          <div className="stack">
            {headToHead.slice(0, PREVIEW_COUNT).map((h) => (
              <RecordRow key={h.name} label={h.name} wins={h.wins} losses={h.losses} gamesPlayed={h.gamesPlayed} />
            ))}
          </div>
        </div>
      )}

      {hasMore && (
        <Link className="btn primary" to="/me/partner-stats" style={{ display: "block", textAlign: "center" }}>
          Show all
        </Link>
      )}
    </div>
  );
}

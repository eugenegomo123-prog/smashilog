import { Icon } from "./Icon";
import { playTime } from "./live";

// Small pieces shared by the host's court cards and the player's court cards,
// so the two screens stay visually identical.

// The top line of a court card: the court's name on the left, how long the
// match has been going on the right.
export function CourtHead({ label, startedAt }: { label: string; startedAt: string }) {
  return (
    <div className="court-head">
      <span className="court-name">{label}</span>
      <span className="court-time" title="Time in play">
        <Icon name="clock" size={14} />
        {playTime(startedAt)}
      </span>
    </div>
  );
}

// A thin line with "VS" in the middle, drawn between the two teams.
export function VsDivider() {
  return (
    <div className="vs-divider" aria-hidden="true">
      <span>VS</span>
    </div>
  );
}

// What a court with no match on it looks like.
export function OpenCourt({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="match-card open-court">
      <Icon name="court" size={20} />
      <div className="open-court-text">
        <div className="court-name">{label}</div>
        <div className="caption-xs">{hint ? `Open · ${hint}` : "Open"}</div>
      </div>
    </div>
  );
}

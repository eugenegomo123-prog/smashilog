import type { ReactNode } from "react";
import { Icon } from "./Icon";

// One tappable row in a list of sessions or names: a title, a line of detail
// under it, something on the left (a level mascot, a rank), and a small arrow
// on the right. The whole row is the button, and it is at least 56px tall so
// it is easy to hit.
export function SessionRow({
  title,
  sub,
  lead,
  trail,
  status,
  onClick,
}: {
  title: string;
  sub?: ReactNode;
  lead?: ReactNode;
  // Replaces the default right-hand arrow.
  trail?: ReactNode;
  // Shows a small Live / Ended tag.
  status?: "active" | "ended";
  onClick: () => void;
}) {
  return (
    <button type="button" className="sess-row" onClick={onClick}>
      {lead && <span className="sess-lead">{lead}</span>}
      <span className="sess-main">
        <span className="sess-title">{title}</span>
        {sub && <span className="sess-sub">{sub}</span>}
      </span>
      {status && <span className={`badge ${status}`}>{status === "active" ? "Live" : "Ended"}</span>}
      {trail ?? <Icon name="chevron-right" size={18} className="sess-arrow" />}
    </button>
  );
}

import type { ReactNode } from "react";

// The title row at the top of a session page, for hosts and players alike:
// the session's name, a LIVE (or ENDED) pill, and an optional action button on
// the right (the host's settings gear). The name may wrap onto a second line
// -- who/what this session is matters more than squeezing it onto one line --
// before it's cut off with an ellipsis.
export function SessionHeader({
  name,
  status,
  action,
}: {
  name: string;
  status: "active" | "ended";
  action?: ReactNode;
}) {
  const live = status === "active";
  return (
    <div className="brand session-head">
      <h1>{name}</h1>
      <span className={`live-pill ${live ? "live" : "ended"}`}>
        <i aria-hidden="true" />
        {live ? "LIVE" : "ENDED"}
      </span>
      {action}
    </div>
  );
}

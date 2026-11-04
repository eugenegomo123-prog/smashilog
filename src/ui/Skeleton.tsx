import type { CSSProperties, ReactNode } from "react";

// Grey placeholder shapes shown while a screen waits for its data. They have
// the same sizes as the real cards, so nothing jumps when the data arrives.
//
// They stay hidden for the first ~150ms (so a fast connection never sees a
// flash) and then gently pulse. The whole group pulses as ONE layer rather
// than every shape on its own, which keeps it cheap on a slow phone. Screen
// readers get a single "Loading…" and skip the shapes. With "reduce motion"
// on, the pulse is switched off by the rule at the bottom of styles.css.

export function Skel({
  w = "100%",
  h = 14,
  r,
  style,
}: {
  w?: number | string;
  h?: number | string;
  r?: number | string;
  style?: CSSProperties;
}) {
  return <span className="skel" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

export function SkeletonGroup({ children, label = "Loading…" }: { children: ReactNode; label?: string }) {
  return (
    <div className="skel-group" role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div className="skel-pulse" aria-hidden="true">
        {children}
      </div>
    </div>
  );
}

// One placeholder row. "rank" = number + picture + name + stat (a leaderboard
// row); "row" = a title with a line under it and an arrow (a session list);
// "match" = a match card with two teams.
function SkelItem({ kind }: { kind: "rank" | "row" | "match" }) {
  if (kind === "match") {
    return (
      <div className="match-card">
        <Skel w="34%" h={12} />
        <div className="skel-match-row">
          <Skel w="58%" h={16} />
          <Skel w={28} h={28} r={8} />
        </div>
        <div className="skel-match-row">
          <Skel w="48%" h={16} />
          <Skel w={28} h={28} r={8} />
        </div>
      </div>
    );
  }
  if (kind === "rank") {
    return (
      <div className="skel-card">
        <Skel w={22} h={16} />
        <Skel w={40} h={40} r="50%" style={{ flex: "none" }} />
        <div className="skel-lines">
          <Skel w="52%" h={15} />
          <Skel w="34%" h={11} />
        </div>
        <Skel w={44} h={22} style={{ flex: "none" }} />
      </div>
    );
  }
  return (
    <div className="skel-card">
      <div className="skel-lines">
        <Skel w="50%" h={16} />
        <Skel w="28%" h={11} />
      </div>
      <Skel w={18} h={18} r={6} style={{ flex: "none" }} />
    </div>
  );
}

// A stack of placeholder rows: the body of a tab or a list page.
export function ListSkeleton({ rows = 4, kind = "row" }: { rows?: number; kind?: "rank" | "row" | "match" }) {
  return (
    <SkeletonGroup>
      <div className="stack">
        {Array.from({ length: rows }, (_, i) => (
          <SkelItem key={i} kind={kind} />
        ))}
      </div>
    </SkeletonGroup>
  );
}

// The bottom bar's shape while a session page loads (five tabs on both the
// host's and the player's page).
function SkelNav() {
  return (
    <div className="tabs skel-tabs">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i}>
          <Skel w={22} h={22} r="50%" />
          <Skel w={30} h={8} r={4} />
        </span>
      ))}
    </div>
  );
}

// A whole page's worth of placeholders: back link, title row, the three stat
// tiles and a couple of court cards. `nav` adds the bottom bar's shape for a
// session page; `list` swaps the stat tiles and courts for plain list rows
// (the join page).
export function PageSkeleton({ nav = false, list = false }: { nav?: boolean; list?: boolean }) {
  return (
    <div className={nav ? "screen rail wide" : "screen"}>
      <SkeletonGroup>
        <Skel w={92} h={16} style={{ margin: "14px 0 20px" }} />
        <div className="skel-head">
          <Skel w="52%" h={30} r={8} />
          {!list && <Skel w={64} h={30} r={999} style={{ flex: "none" }} />}
        </div>
        <Skel w="34%" h={13} style={{ margin: "6px 0 18px" }} />
        {list ? (
          <div className="stack">
            {Array.from({ length: 5 }, (_, i) => (
              <SkelItem key={i} kind="row" />
            ))}
          </div>
        ) : (
          <>
            <div className="stat-tiles">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className="stat-tile">
                  <Skel w={34} h={30} r={8} />
                  <Skel w="60%" h={11} style={{ marginTop: 4 }} />
                </div>
              ))}
            </div>
            <Skel w={72} h={14} style={{ marginBottom: 12 }} />
            <div className="stack cols">
              <SkelItem kind="match" />
              <SkelItem kind="match" />
            </div>
          </>
        )}
        {nav && <SkelNav />}
      </SkeletonGroup>
    </div>
  );
}

// The big rank-badge card (picture circle and a title) while it loads.
export function BadgeSkeleton() {
  return (
    <SkeletonGroup>
      <div className="skel-badge">
        <Skel w={150} h={150} r="50%" />
        <Skel w={120} h={22} style={{ marginTop: 16 }} />
      </div>
    </SkeletonGroup>
  );
}

// A player's profile while it loads: picture + name, then the big badge card.
export function ProfileSkeleton() {
  return (
    <SkeletonGroup>
      <div className="skel-head" style={{ gap: 12, marginBottom: 16 }}>
        <Skel w={56} h={56} r="50%" style={{ flex: "none" }} />
        <Skel w="46%" h={28} r={8} />
      </div>
      <div className="skel-badge">
        <Skel w={150} h={150} r="50%" />
        <Skel w={120} h={22} style={{ marginTop: 16 }} />
      </div>
    </SkeletonGroup>
  );
}

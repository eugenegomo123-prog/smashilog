import { useState } from "react";
import { accountPictureUrl } from "./api";

// Same initials-fallback behavior as ParticipantSession.tsx's session-scoped
// Avatar, for the contexts that only have an account id and no session
// Player row to key off of: the Account tab's own preview (PlayerHome.tsx),
// another member's public profile (PlayerProfile.tsx), and the cross-session
// Ranking tab (PlayerHome.tsx). Shares the .avatar CSS class for a
// consistent look everywhere a picture shows up.
export function AccountAvatar({
  username,
  accountId,
  pictureUpdatedAt,
  size = 48,
}: {
  username: string;
  accountId: number;
  pictureUpdatedAt: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const initials =
    username
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "?";
  const style = { width: size, height: size, fontSize: Math.round(size * 0.36) };
  // No pictureUpdatedAt means this account has never set one -- skip the
  // (guaranteed 404) image request and go straight to initials.
  if (!pictureUpdatedAt || failed) {
    return (
      <div className="avatar" style={style}>
        {initials}
      </div>
    );
  }
  return (
    <img
      className="avatar"
      style={style}
      src={accountPictureUrl(accountId, pictureUpdatedAt)}
      alt={username}
      onError={() => setFailed(true)}
    />
  );
}

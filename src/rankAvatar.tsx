import { useState } from "react";
import { playerPictureUrl, type Player } from "./api";
import { initialsOf } from "./initials";

// What a Ranking tab shows for a player: their uploaded photo if they're a
// registered account holder who's set one, or their initials on a circle
// otherwise (the same look as every other no-photo avatar in the app -- the
// .avatar class). Only account holders can have a picture (see
// db/schema.ts's accounts.profilePicture), so a guest always gets initials.
//
// Fills whatever box the caller places it in (the podium's circular
// .podium-avatar, or the small .rank-ava next to a name) -- this itself has no
// size opinion, which is what lets the one component serve both. The initials
// are sized from that box's font size (0.72em), so they grow with it. Shared
// between ParticipantSession.tsx's and HostSession.tsx's Ranking tabs (each
// has its own copy of that tab -- see shareImage.ts's comment on why -- but
// this one piece is small enough to share directly).
export function RankAvatar({ player }: { player: Player }) {
  const [failed, setFailed] = useState(false);
  if (player.accountId && !failed) {
    return (
      <img
        src={playerPictureUrl(player)}
        alt={player.name}
        onError={() => setFailed(true)}
        style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "50%" }}
      />
    );
  }
  // Decorative: the player's name is written right next to it.
  return (
    <span className="avatar" style={{ width: "100%", height: "100%", fontSize: "0.72em" }} aria-hidden="true">
      {initialsOf(player.name)}
    </span>
  );
}

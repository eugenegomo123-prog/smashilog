import { useState } from "react";
import { LEVEL_ICON, playerPictureUrl, type Player } from "./api";

// What a Ranking tab shows for a player: their uploaded photo if they're a
// registered account holder who's set one, or the level icon otherwise --
// exactly what that spot showed before pictures existed. Only account
// holders can have a picture (see db/schema.ts's accounts.profilePicture),
// so a guest always falls straight to the level icon.
//
// Fills whatever box the caller places it in (the podium's circular
// .podium-avatar, or a small inline .rank-row-icon next to a name) -- this
// itself has no size opinion, which is what lets the one component serve
// both. Shared between ParticipantSession.tsx's and HostSession.tsx's
// Ranking tabs (each has its own copy of that tab -- see shareImage.ts's
// comment on why -- but this one piece is small enough to share directly).
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
  return <>{LEVEL_ICON[player.level]}</>;
}

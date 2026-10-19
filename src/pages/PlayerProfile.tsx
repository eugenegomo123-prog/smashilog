import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { accountPictureUrl, api, TIER_BADGE_IMAGE } from "../api";
import { AccountAvatar } from "../accountAvatar";
import { OverallRecordCard, type OverallRecordStats } from "../overallRecord";

// Same shape as api.ts's getAccountProfile() response -- kept here rather
// than exported from api.ts since nothing else needs it yet.
interface AccountProfile {
  username: string;
  pictureUpdatedAt: string | null;
  stats: OverallRecordStats;
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
// else: no rank-up banner (that's personal) and no account actions. The
// header photo is clickable (when they've actually set one) and opens it
// full-size in an overlay -- the account picture is only ever stored/served
// at 320x320 (see imageUpload.ts's compressImageFile), so "full-size" here
// just means bigger than the 56px header thumbnail, not higher-resolution.
export default function PlayerProfile() {
  const { id } = useParams();
  const accountId = Number(id);
  const navigate = useNavigate();
  const [profile, setProfile] = useState<AccountProfile | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [photoOpen, setPhotoOpen] = useState(false);

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

  // Esc closes the enlarged photo, same as clicking outside it.
  useEffect(() => {
    if (!photoOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPhotoOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photoOpen]);

  if (!api.isPlayerLoggedIn()) return null;

  return (
    <div className="screen">
      {/* Reached only from PlayerHome's Ranking tab today -- this sends
          "back" straight to that tab (via PlayerHome's ?tab= query param)
          instead of the default Stats tab. */}
      <Link className="back-link" to="/me?tab=ranking">
        ← Back
      </Link>

      {!loaded && <div className="empty-state">Loading…</div>}
      {loaded && !profile && <div className="empty-state">Couldn't find that player.</div>}

      {profile && (
        <>
          <div className="brand" style={{ gap: 12 }}>
            {profile.pictureUpdatedAt ? (
              <button
                type="button"
                className="avatar-button"
                onClick={() => setPhotoOpen(true)}
                aria-label={`View ${profile.username}'s full photo`}
              >
                <AccountAvatar
                  username={profile.username}
                  accountId={accountId}
                  pictureUpdatedAt={profile.pictureUpdatedAt}
                  size={56}
                />
              </button>
            ) : (
              <AccountAvatar
                username={profile.username}
                accountId={accountId}
                pictureUpdatedAt={profile.pictureUpdatedAt}
                size={56}
              />
            )}
            <h1>{profile.username}</h1>
          </div>

          {photoOpen && profile.pictureUpdatedAt && (
            <div className="modal-overlay" onClick={() => setPhotoOpen(false)}>
              <div className="photo-modal" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="photo-modal-close"
                  onClick={() => setPhotoOpen(false)}
                  aria-label="Close"
                >
                  ×
                </button>
                <img
                  src={accountPictureUrl(accountId, profile.pictureUpdatedAt)}
                  alt={profile.username}
                  onError={() => setPhotoOpen(false)}
                />
              </div>
            </div>
          )}

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

          <div style={{ marginTop: 12 }}>
            <OverallRecordCard stats={profile.stats} />
          </div>
        </>
      )}
    </div>
  );
}

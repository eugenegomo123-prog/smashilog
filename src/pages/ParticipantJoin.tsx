import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, LEVELS, LEVEL_ICON, LEVEL_LABEL, type Level, type Player, type Session } from "../api";

function playerKey(sessionId: number) {
  return `smashilog_player_${sessionId}`;
}

export default function ParticipantJoin() {
  const { id } = useParams();
  const sessionId = Number(id);
  const navigate = useNavigate();
  const isLoggedIn = api.isPlayerLoggedIn();

  const [session, setSession] = useState<Session | null>(null);
  const [players, setPlayers] = useState<Player[]>([]);
  const [mode, setMode] = useState<"pick" | "request">("pick");
  const [name, setName] = useState("");
  const [level, setLevel] = useState<Level>("C");
  const [error, setError] = useState("");
  const [requested, setRequested] = useState(false);
  const [accountPlayer, setAccountPlayer] = useState<Player | null | undefined>(undefined);
  const [accountLevel, setAccountLevel] = useState<Level | null>(null);

  useEffect(() => {
    if (isLoggedIn) return;
    const existing = localStorage.getItem(playerKey(sessionId));
    if (existing) {
      navigate(`/session/${sessionId}`);
      return;
    }
    api.getSession(sessionId).then(setSession);
    api.listPlayers(sessionId).then(setPlayers);
  }, [sessionId, isLoggedIn]);

  useEffect(() => {
    if (!isLoggedIn) return;
    api.getSession(sessionId).then(setSession);
    api.getMe().then((me) => setAccountLevel(me.level));
    api.getMyPlayerInSession(sessionId).then((p) => {
      setAccountPlayer(p);
      if (p?.approved) navigate(`/session/${sessionId}`);
      else if (p && !p.approved) setRequested(true);
    });
  }, [sessionId, isLoggedIn]);

  const approvedRoster = players.filter((p) => p.approved);

  function pickName(player: Player) {
    localStorage.setItem(playerKey(sessionId), String(player.id));
    navigate(`/session/${sessionId}`);
  }

  async function requestToJoin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const player = await api.joinSession(sessionId, name.trim(), level);
      localStorage.setItem(playerKey(sessionId), String(player.id));
      setRequested(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit request");
    }
  }

  async function requestToJoinAsAccount() {
    setError("");
    try {
      await api.requestToJoinAsAccount(sessionId);
      setRequested(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit request");
    }
  }

  const backTo = isLoggedIn ? "/me" : "/join";
  const backLabel = isLoggedIn ? "← My account" : "← All sessions";

  if (requested) {
    return (
      <div className="screen">
        <Link className="back-link" to={backTo}>
          {backLabel}
        </Link>
        <div className="brand">
          <h1>Request sent</h1>
        </div>
        <p className="subtitle">
          Your join request is waiting for host approval. This page will move on automatically once approved.
        </p>
        <PendingWatcher sessionId={sessionId} isAccount={isLoggedIn} />
      </div>
    );
  }

  if (!session) return <div className="screen empty-state">Loading…</div>;

  if (isLoggedIn) {
    return (
      <div className="screen">
        <Link className="back-link" to="/me">
          ← My account
        </Link>
        <div className="brand">
          <h1>{session.name}</h1>
        </div>
        <p className="subtitle">Request to join as {api.playerUsername()}.</p>
        <div className="card">
          <div style={{ fontSize: 13, color: "var(--muted)" }}>Your level</div>
          <div style={{ fontWeight: 700, fontSize: 18, marginTop: 2 }}>
            {accountLevel ? `${LEVEL_ICON[accountLevel]} ${accountLevel} · ${LEVEL_LABEL[accountLevel]}` : "Loading…"}
          </div>
          <div className="subtitle" style={{ marginTop: 6 }}>
            Set in your account settings -- change it there any time.
          </div>
        </div>
        {error && (
          <div className="error-text" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
        <button
          className="btn primary"
          style={{ marginTop: 16 }}
          onClick={requestToJoinAsAccount}
          disabled={accountPlayer === undefined || accountLevel === null}
        >
          Request to join
        </button>
      </div>
    );
  }

  return (
    <div className="screen">
      <Link className="back-link" to="/join">
        ← All sessions
      </Link>
      <div className="brand">
        <h1>{session.name}</h1>
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <button className={`btn ${mode === "pick" ? "primary" : ""}`} onClick={() => setMode("pick")}>
          Select my name
        </button>
        <button className={`btn ${mode === "request" ? "primary" : ""}`} onClick={() => setMode("request")}>
          Request to join
        </button>
      </div>

      {mode === "pick" ? (
        <div className="stack">
          {approvedRoster.map((p) => (
            <button key={p.id} className="big-btn ghost" onClick={() => pickName(p)}>
              {p.name}
            </button>
          ))}
          {approvedRoster.length === 0 && <div className="empty-state">No approved players yet — request to join instead.</div>}
        </div>
      ) : (
        <form className="stack" onSubmit={requestToJoin}>
          <div>
            <label>Your name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
          </div>
          <div>
            <label>Requested level</label>
            <select value={level} onChange={(e) => setLevel(e.target.value as Level)}>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {LEVEL_ICON[l]} {l} · {LEVEL_LABEL[l]}
                </option>
              ))}
            </select>
          </div>
          {error && <div className="error-text">{error}</div>}
          <button className="btn primary" type="submit" disabled={!name.trim()}>
            Send request
          </button>
        </form>
      )}
    </div>
  );
}

function PendingWatcher({ sessionId, isAccount }: { sessionId: number; isAccount: boolean }) {
  const navigate = useNavigate();
  useEffect(() => {
    const interval = setInterval(async () => {
      if (isAccount) {
        const mine = await api.getMyPlayerInSession(sessionId);
        if (mine?.approved) {
          clearInterval(interval);
          navigate(`/session/${sessionId}`);
        }
        return;
      }
      const playerId = Number(localStorage.getItem(playerKey(sessionId)));
      const list = await api.listPlayers(sessionId);
      const me = list.find((p) => p.id === playerId);
      if (me?.approved) {
        clearInterval(interval);
        navigate(`/session/${sessionId}`);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [sessionId, isAccount]);
  return null;
}

export { playerKey };

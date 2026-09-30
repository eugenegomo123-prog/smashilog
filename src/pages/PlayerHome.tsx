import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

export default function PlayerHome() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!api.isPlayerLoggedIn()) {
      navigate("/login");
    }
  }, []);

  if (!api.isPlayerLoggedIn()) return null;

  return (
    <div className="screen">
      <a className="back-link" href="/">
        ← Back
      </a>
      <div className="brand">
        <h1>Hi, {api.playerUsername()}</h1>
      </div>
      <p className="subtitle">
        Your overall stats, ranking, and match history are coming here soon — this account is ready to go.
      </p>
      <button
        className="btn danger"
        onClick={() => {
          api.clearPlayerSession();
          navigate("/");
        }}
      >
        Log out
      </button>
    </div>
  );
}

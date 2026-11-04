import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Icon } from "../ui/Icon";

export default function Home() {
  const navigate = useNavigate();
  const loggedIn = api.isPlayerLoggedIn();

  return (
    <div className="screen home-screen">
      <div className="home-main">
        <div className="brand">
          <h1>
            Smashilog<span className="dot">.</span>
          </h1>
        </div>
        <p className="subtitle">Tara, Smash!</p>
        <div className="stack" style={{ marginTop: 40 }}>
          {loggedIn ? (
            <button className="big-btn primary" onClick={() => navigate("/me")}>
              <Icon name="user" size={22} />
              Continue as {api.playerUsername()}
            </button>
          ) : (
            <button className="big-btn primary" onClick={() => navigate("/login")}>
              <Icon name="user" size={22} />
              Login
            </button>
          )}
          <button className="big-btn ghost" onClick={() => navigate("/join")}>
            <Icon name="users" size={22} />
            Join as Guest
          </button>
        </div>
      </div>
      <Link className="host-corner-link" to="/host">
        Host
        <Icon name="chevron-right" size={16} />
      </Link>
    </div>
  );
}

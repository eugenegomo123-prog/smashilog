import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { api, LOGINS_CHANGED_EVENT } from "./api";
import Home from "./pages/Home";
import HostLogin from "./pages/HostLogin";
import HostSessions from "./pages/HostSessions";
import HostSession from "./pages/HostSession";
import ParticipantSessions from "./pages/ParticipantSessions";
import ParticipantJoin from "./pages/ParticipantJoin";
import ParticipantSession from "./pages/ParticipantSession";
import Login from "./pages/Login";
import Register from "./pages/Register";
import PlayerHome from "./pages/PlayerHome";
import PlayerProfile from "./pages/PlayerProfile";
import PartnerStatsPage from "./pages/PartnerStatsPage";
import { DialogHost } from "./dialogs";

export default function App() {
  // The browser remembers host / player logins between visits. When the app
  // finds one has expired (see dropExpiredLogins in api.ts) it deletes it and
  // fires LOGINS_CHANGED_EVENT; bumping this number below redraws the current
  // page from scratch, so it notices it is signed out and shows its login
  // screen instead of staying stuck on a page that can only say "Unauthorized".
  const [loginsVersion, setLoginsVersion] = useState(0);
  useEffect(() => {
    const onChanged = () => setLoginsVersion((v) => v + 1);
    window.addEventListener(LOGINS_CHANGED_EVENT, onChanged);
    // Check any saved login once, as the app opens.
    api.checkSavedLogins();
    return () => window.removeEventListener(LOGINS_CHANGED_EVENT, onChanged);
  }, []);

  return (
    <>
      <Routes key={loginsVersion}>
        <Route path="/" element={<Home />} />
        <Route path="/host" element={<HostLogin />} />
        <Route path="/host/sessions" element={<HostSessions />} />
        <Route path="/host/sessions/:id" element={<HostSession />} />
        <Route path="/join" element={<ParticipantSessions />} />
        <Route path="/join/:id" element={<ParticipantJoin />} />
        <Route path="/session/:id" element={<ParticipantSession />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/me" element={<PlayerHome />} />
        <Route path="/me/partner-stats" element={<PartnerStatsPage />} />
        <Route path="/player/:id" element={<PlayerProfile />} />
      </Routes>
      {/* Draws the in-app alert/confirm/prompt dialogs (src/dialogs.tsx) on top of whichever page is open. */}
      <DialogHost />
    </>
  );
}

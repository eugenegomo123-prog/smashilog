import { Route, Routes } from "react-router-dom";
import Home from "./pages/Home";
import HostLogin from "./pages/HostLogin";
import HostSessions from "./pages/HostSessions";
import HostSession from "./pages/HostSession";
import ParticipantSessions from "./pages/ParticipantSessions";
import ParticipantJoin from "./pages/ParticipantJoin";
import ParticipantSession from "./pages/ParticipantSession";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/host" element={<HostLogin />} />
      <Route path="/host/sessions" element={<HostSessions />} />
      <Route path="/host/sessions/:id" element={<HostSession />} />
      <Route path="/join" element={<ParticipantSessions />} />
      <Route path="/join/:id" element={<ParticipantJoin />} />
      <Route path="/session/:id" element={<ParticipantSession />} />
    </Routes>
  );
}

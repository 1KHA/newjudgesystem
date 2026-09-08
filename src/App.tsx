import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import RequireAuth from './components/RequireAuth';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import SetupPage from './pages/SetupPage';
import ControlPage from './pages/ControlPage';
import JudgePage from './pages/JudgePage';
import QuestionsPage from './pages/QuestionsPage';
import ResultsPage from './pages/ResultsPage';
import HealthPage from './pages/HealthPage';
import './styles/globals.css';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Navigate to="/host" replace />} />

        {/* Public */}
        <Route path="/login" element={<LoginPage />} />
        {/* Judges join ONLY through the per-session link shared by the host */}
        <Route path="/judge/:sessionId" element={<JudgePage />} />
        <Route path="/judge" element={<JudgePage />} />

        {/* Admin only */}
        <Route path="/host" element={<RequireAuth><DashboardPage /></RequireAuth>} />
        <Route path="/host/new" element={<RequireAuth><SetupPage /></RequireAuth>} />
        <Route path="/host/:sessionId/control" element={<RequireAuth><ControlPage /></RequireAuth>} />
        <Route path="/questions" element={<RequireAuth><QuestionsPage /></RequireAuth>} />
        <Route path="/results" element={<RequireAuth><ResultsPage /></RequireAuth>} />
        <Route path="/health" element={<RequireAuth><HealthPage /></RequireAuth>} />

        <Route path="*" element={<Navigate to="/host" replace />} />
      </Routes>
    </Router>
  );
}

export default App;

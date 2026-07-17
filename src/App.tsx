import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import HostPage from './pages/HostPage';
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
        <Route path="/host" element={<HostPage />} />
        <Route path="/judge" element={<JudgePage />} />
        <Route path="/questions" element={<QuestionsPage />} />
        <Route path="/results" element={<ResultsPage />} />
        <Route path="/health" element={<HealthPage />} />
        <Route path="*" element={<Navigate to="/host" replace />} />
      </Routes>
    </Router>
  );
}

export default App;

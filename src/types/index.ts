export interface Team {
  id: string;
  name: string;
  track?: string | null;
  display_order?: number;
  created_at?: string;
}

/** A team as it is placed into a session (name + track snapshot). */
export interface SessionTeam {
  name: string;
  track: string | null;
}

export interface QuestionBank {
  id: string;
  name: string;
  created_at?: string;
  questions?: Question[];
}

export interface QuestionChoice {
  text: string;
  weight: number;
}

export interface Question {
  id: string;
  text: string;
  choices: string[] | QuestionChoice[]; // Support both formats for backward compatibility
  section: string;
  weight: number;
  bank_id?: string;
  created_at?: string;
}

export interface Judge {
  id: string;
  name: string;
  judge_token?: string;
  session_id?: string;
  last_seen_at?: string | null;
  created_at?: string;
}

export type SessionStatus = 'active' | 'completed';

/** Row in `sessions`. Teams and questions live in their own tables. */
export interface Session {
  id: string;
  name: string;
  session_id: string;
  host_token?: string;
  host_id?: string | null; // auth.users id of the admin who owns this session
  current_team_index: number;
  current_team_id?: string | null;
  status: SessionStatus;
  total_points: number;
  created_at?: string;
  updated_at?: string;
}

/** Session plus its ordered teams and questions (joined from session_teams / session_questions). */
export interface SessionDetail extends Session {
  teams: string[];
  /** team name -> track (null when the team has no track) */
  teamTracks: Record<string, string | null>;
  questions: Question[];
}

/** Session list row with a team count (dashboard). */
export interface SessionSummary extends Session {
  team_count: number;
}

export interface Answer {
  id: string;
  answer: string;
  points?: number;
  question_id: string;
  team_id: string;
  judge_id: string;
  session_id: string;
  created_at?: string;
  updated_at?: string;
}

export interface SessionResult {
  id: string;
  session_id: string;
  team_id: string;
  track?: string | null;
  total_points: number;
  answer_count: number;
  judge_count: number;
  overall_rank?: number | null;
  track_rank?: number | null;
  created_at?: string;
  updated_at?: string;
}

/** One row of the server-side `session_leaderboard()` aggregate. */
export interface LeaderboardEntry {
  teamName: string;
  track: string | null;
  totalPoints: number;
  answerCount: number;
  judgeCount: number;
  /** 1-based place among all teams; tied teams share a place */
  overallRank: number;
  /** 1-based place within the team's track; tied teams share a place */
  trackRank: number;
}

/** Per-judge progress for the team currently being judged. */
export interface JudgeProgress {
  [judgeId: string]: { answered: number; lastAnswerAt: string | null };
}

/** A single answer row for display, with the judge and question resolved. */
export interface TeamAnswerRow {
  id: string;
  judgeId: string;
  judgeName: string;
  questionId: string;
  questionText: string;
  answer: string;
  points: number;
  createdAt: string;
}

/** An answer waiting in the judge's offline queue. */
export interface PendingAnswer {
  key: string; // `${team}|${question}` — later writes for the same key replace earlier ones
  session_id: string;
  team_id: string;
  judge_id: string;
  question_id: string;
  answer: string;
  points: number;
  queuedAt: number;
  attempts: number;
}

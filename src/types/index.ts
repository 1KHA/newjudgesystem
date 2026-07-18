export interface Team {
  id: string;
  name: string;
  display_order?: number;
  created_at?: string;
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
  created_at?: string;
}

export interface Session {
  id: string;
  name: string;
  session_id: string;
  host_token?: string;
  host_id?: string; // auth.users id of the admin who owns this session
  current_team_index: number;
  teams: string[];
  current_questions?: Question[];
  current_team_id?: string;
  total_points: number;
  created_at?: string;
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
}

export interface SessionResult {
  id: string;
  session_id: string;
  team_id: string;
  total_points: number;
  details: any;
  created_at?: string;
}

export interface LeaderboardEntry {
  teamName: string;
  totalPoints: number;
}

export interface AnswersByTeam {
  [teamName: string]: {
    player: string;
    answer: string;
  }[];
}

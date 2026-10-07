import { supabase } from './supabase';
import type {
  Team, Question, QuestionBank, Judge, Session, SessionDetail, SessionSummary, SessionTeam,
  Answer, SessionResult, LeaderboardEntry, JudgeProgress, TeamAnswerRow
} from '../types';

/**
 * Data access layer.
 *
 * Rules that keep the app stable under load (see stress/ and
 * supabase-schema.sql):
 *   - Never fetch an unbounded list. Anything that grows with the number of
 *     answers is aggregated server-side (RPC) or filtered to one team.
 *   - Answers are written with upsert on the unique
 *     (session, team, judge, question) key, so retries are idempotent.
 *   - No JSON blobs: teams and questions live in session_teams /
 *     session_questions, answer choices in question_choices.
 *   - Points are worked out by the server from the chosen choice
 *     (answers_set_points); devices never send points.
 */

// ---------------------------------------------------------------- Teams ----

export const getTeams = async (): Promise<Team[]> => {
  const { data, error } = await supabase
    .from('teams')
    .select('*')
    .order('display_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
};

/**
 * Save teams from an uploaded file in ONE request.
 * Existing names are updated (track + order), new names are inserted.
 * `display_order` follows the file order, which becomes the judging order.
 */
export const upsertTeams = async (rows: SessionTeam[]): Promise<Team[]> => {
  const payload = rows.map((t, i) => ({ name: t.name, track: t.track, display_order: i }));
  const { data, error } = await supabase
    .from('teams')
    .upsert(payload, { onConflict: 'name' })
    .select();
  if (error) throw error;
  return data || [];
};

// ------------------------------------------------------------ Questions ----

export const getQuestionBanks = async (): Promise<QuestionBank[]> => {
  const { data, error } = await supabase.from('question_banks').select('*').order('name');
  if (error) throw error;
  return data || [];
};

/** Question columns plus its choices (rows in question_choices). */
const QUESTION_COLUMNS = 'id, text, section, weight, bank_id, created_at, question_choices(id, text, weight, position)';

type QuestionRow = Omit<Question, 'choices' | 'weight'> & {
  weight: number | string | null;
  question_choices: { id: string; text: string; weight: number | string; position: number }[] | null;
};

const toQuestion = (row: QuestionRow, maxPoints?: number | string | null): Question => {
  const { question_choices, ...rest } = row;
  return {
    ...rest,
    weight: Number(row.weight ?? 1),
    choices: (question_choices || [])
      .map((c) => ({ id: c.id, text: c.text, weight: Number(c.weight), position: c.position }))
      .sort((a, b) => a.position - b.position),
    ...(maxPoints != null ? { maxPoints: Number(maxPoints) } : {}),
  };
};

export const getQuestions = async (bankId?: string): Promise<Question[]> => {
  let query = supabase.from('questions').select(QUESTION_COLUMNS);
  if (bankId) query = query.eq('bank_id', bankId);
  const { data, error } = await query.order('text');
  if (error) throw error;
  return ((data || []) as unknown as QuestionRow[]).map((r) => toQuestion(r));
};

export interface NewBankQuestion {
  text: string;
  section: string;
  /** Section weight (the section's share of the session total). */
  weight: number;
  choices: { text: string; weight: number }[];
}

/**
 * Saves a bank with its questions and choices in ONE transaction
 * (create_question_bank): either everything is saved or nothing is.
 * The server validates and returns an Arabic message on bad input.
 */
export const createQuestionBank = async (name: string, questions: NewBankQuestion[]): Promise<string> => {
  const { data, error } = await supabase.rpc('create_question_bank', { p_name: name, p_questions: questions });
  if (error) throw error;
  return data as string;
};

export const getQuestionsByBank = async (bankId: string): Promise<Question[]> => getQuestions(bankId);

// ------------------------------------------------------------- Sessions ----

const SESSION_COLUMNS = 'id, name, session_id, host_token, host_id, current_team_index, current_team_id, status, total_points, created_at, updated_at';

/**
 * Creates a session together with its team list and question list.
 * Rolls the session row back if either child insert fails.
 * The session starts with no current team: judges who join wait until the
 * host starts judging (startSession).
 */
export const createSession = async (input: {
  name: string;
  session_id: string;
  host_token: string;
  host_id?: string;
  teams: SessionTeam[];
  questionIds: string[];
  total_points: number;
}): Promise<Session> => {
  const { teams, questionIds, ...row } = input;
  const { data: session, error } = await supabase
    .from('sessions')
    .insert({ ...row, status: 'active', current_team_index: 0, current_team_id: null })
    .select(SESSION_COLUMNS)
    .single();
  if (error) throw error;

  try {
    const { error: tErr } = await supabase.from('session_teams').insert(
      teams.map((t, position) => ({ session_id: session.session_id, name: t.name, track: t.track, position }))
    );
    if (tErr) throw tErr;

    const { error: qErr } = await supabase.from('session_questions').insert(
      questionIds.map((question_id, position) => ({ session_id: session.session_id, question_id, position }))
    );
    if (qErr) throw qErr;
  } catch (e) {
    await supabase.from('sessions').delete().eq('session_id', session.session_id);
    throw e;
  }
  return session as Session;
};

/** Sessions owned by an admin, newest first, with a team count (dashboard). */
export const getSessionsByHost = async (hostId: string): Promise<SessionSummary[]> => {
  const { data, error } = await supabase
    .from('sessions')
    .select(`${SESSION_COLUMNS}, session_teams(count)`)
    .eq('host_id', hostId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((row) => {
    const { session_teams, ...rest } = row as Session & { session_teams: { count: number }[] };
    return { ...rest, team_count: session_teams?.[0]?.count ?? 0 };
  });
};

/** All sessions, newest first (results page). Light: no children. */
export const getAllSessions = async (): Promise<SessionSummary[]> => {
  const { data, error } = await supabase
    .from('sessions')
    .select(`${SESSION_COLUMNS}, session_teams(count)`)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((row) => {
    const { session_teams, ...rest } = row as Session & { session_teams: { count: number }[] };
    return { ...rest, team_count: session_teams?.[0]?.count ?? 0 };
  });
};

/** Session row only (cheap; used by polling). */
export const getSession = async (sessionId: string): Promise<Session | null> => {
  const { data, error } = await supabase
    .from('sessions')
    .select(SESSION_COLUMNS)
    .eq('session_id', sessionId)
    .maybeSingle();
  if (error) throw error;
  return (data as Session) ?? null;
};

/** Session + ordered teams + ordered questions. */
export const getSessionDetail = async (sessionId: string): Promise<SessionDetail | null> => {
  const session = await getSession(sessionId);
  if (!session) return null;
  const [teams, questions] = await Promise.all([getSessionTeams(sessionId), getSessionQuestions(sessionId)]);
  return {
    ...session,
    teams: teams.map((t) => t.name),
    teamTracks: Object.fromEntries(teams.map((t) => [t.name, t.track])),
    questions,
  };
};

/** Ordered teams of a session with their tracks (loaded once per page; teams never change mid-session). */
export const getSessionTeams = async (sessionId: string): Promise<SessionTeam[]> => {
  const { data, error } = await supabase
    .from('session_teams')
    .select('name, track, position')
    .eq('session_id', sessionId)
    .order('position');
  if (error) throw error;
  return (data || []).map((t) => ({ name: t.name, track: t.track ?? null }));
};

/** Ordered questions of a session, each with its choices and the points it is worth here. */
export const getSessionQuestions = async (sessionId: string): Promise<Question[]> => {
  const { data, error } = await supabase
    .from('session_questions')
    .select(`position, max_points, questions(${QUESTION_COLUMNS})`)
    .eq('session_id', sessionId)
    .order('position');
  if (error) throw error;
  return ((data || []) as unknown as { max_points: number | string | null; questions: QuestionRow | null }[])
    .filter((r) => r.questions)
    .map((r) => toQuestion(r.questions!, r.max_points));
};

export const setCurrentTeam = async (sessionId: string, index: number, team: string): Promise<void> => {
  const { error } = await supabase
    .from('sessions')
    .update({ current_team_index: index, current_team_id: team, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId);
  if (error) throw error;
};

/**
 * Starts judging: the first team becomes the current team. Only acts on a
 * session that has not started yet, so pressing start again (another tab, a
 * retry) never sends a running session back to the first team.
 * Returns the first team, or null when the session was already started.
 */
export const startSession = async (sessionId: string): Promise<string | null> => {
  const { data: first, error: tErr } = await supabase
    .from('session_teams')
    .select('name')
    .eq('session_id', sessionId)
    .order('position')
    .limit(1)
    .maybeSingle();
  if (tErr) throw tErr;
  if (!first) return null;
  const { data, error } = await supabase
    .from('sessions')
    .update({ current_team_index: 0, current_team_id: first.name, updated_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .is('current_team_id', null)
    .select('session_id');
  if (error) throw error;
  return data && data.length > 0 ? first.name : null;
};

/** Finalises a session server-side: totals into session_results, status = completed. */
export const finishSession = async (sessionId: string): Promise<number> => {
  const { data, error } = await supabase.rpc('finish_session', { p_session_id: sessionId });
  if (error) throw error;
  return Number(data ?? 0);
};

export const deleteSession = async (sessionId: string): Promise<void> => {
  const { error } = await supabase.from('sessions').delete().eq('session_id', sessionId);
  if (error) throw error;
};

// --------------------------------------------------------------- Judges ----

export const getOrCreateJudge = async (judgeData: {
  name: string;
  judge_token: string;
  session_id: string;
}): Promise<Judge> => {
  const { data: existing, error: findError } = await supabase
    .from('judges')
    .select('*')
    .eq('name', judgeData.name)
    .eq('session_id', judgeData.session_id)
    .maybeSingle();
  if (findError) throw findError;

  if (existing) {
    const { data, error } = await supabase
      .from('judges')
      .update({ judge_token: judgeData.judge_token, last_seen_at: new Date().toISOString() })
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from('judges')
    .insert({ ...judgeData, last_seen_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const getJudgesBySession = async (sessionId: string): Promise<Judge[]> => {
  const { data, error } = await supabase
    .from('judges')
    .select('*')
    .eq('session_id', sessionId)
    .order('name');
  if (error) throw error;
  return data || [];
};

export const getJudge = async (name: string, token: string): Promise<Judge | null> => {
  const { data, error } = await supabase
    .from('judges')
    .select('*')
    .eq('name', name)
    .eq('judge_token', token)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
};

/** Lightweight presence ping; failures are ignored by callers. */
export const touchJudge = async (judgeId: string): Promise<void> => {
  await supabase.from('judges').update({ last_seen_at: new Date().toISOString() }).eq('id', judgeId);
};

// -------------------------------------------------------------- Answers ----

/** Abort a write that has not answered within this time, so one stuck request
 *  cannot hold back every later answer in the judge's queue. */
const ANSWER_TIMEOUT_MS = 10_000;

/**
 * Idempotent write: one row per (session, team, judge, question).
 * Re-sending the same answer (offline replay, retry) is harmless.
 * The server sets `points` from the choice.
 */
export const upsertAnswer = async (answerData: {
  answer: string;
  /** Missing only for answers queued by builds before v4 (matched by text). */
  choice_id?: string;
  question_id: string;
  team_id: string;
  judge_id: string;
  session_id: string;
}): Promise<Answer> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANSWER_TIMEOUT_MS);
  try {
    const { data, error } = await supabase
      .from('answers')
      .upsert({ ...answerData, updated_at: new Date().toISOString() }, {
        onConflict: 'session_id,team_id,judge_id,question_id'
      })
      .select()
      .abortSignal(controller.signal)
      .single();
    if (error) throw error;
    return data;
  } finally {
    clearTimeout(timer);
  }
};

/** A judge's own answers for one team (bounded by question count). */
export const getJudgeAnswersForTeam = async (
  sessionId: string, judgeId: string, teamId: string
): Promise<Pick<Answer, 'question_id' | 'answer' | 'choice_id'>[]> => {
  const { data, error } = await supabase
    .from('answers')
    .select('question_id, answer, choice_id')
    .eq('session_id', sessionId)
    .eq('judge_id', judgeId)
    .eq('team_id', teamId);
  if (error) throw error;
  return data || [];
};

/** Answers for one team with judge + question resolved (bounded: judges x questions). */
export const getTeamAnswers = async (sessionId: string, teamId: string): Promise<TeamAnswerRow[]> => {
  const { data, error } = await supabase
    .from('answers')
    .select('id, answer, points, question_id, judge_id, created_at, judges(name), questions(text)')
    .eq('session_id', sessionId)
    .eq('team_id', teamId)
    .order('created_at');
  if (error) throw error;
  return (data || []).map((r) => {
    const row = r as unknown as {
      id: string; answer: string; points: number | null; question_id: string; judge_id: string;
      created_at: string; judges: { name: string } | null; questions: { text: string } | null;
    };
    return {
      id: row.id,
      judgeId: row.judge_id,
      judgeName: row.judges?.name ?? row.judge_id,
      questionId: row.question_id,
      questionText: row.questions?.text ?? '',
      answer: row.answer,
      points: Number(row.points ?? 1),
      createdAt: row.created_at
    };
  });
};

/** Per-judge answer counts for the current team (server aggregate). */
export const getTeamProgress = async (sessionId: string, teamId: string): Promise<JudgeProgress> => {
  const { data, error } = await supabase.rpc('session_team_progress', {
    p_session_id: sessionId, p_team: teamId
  });
  if (error) throw error;
  const out: JudgeProgress = {};
  for (const row of (data || []) as { judge_id: string; answered: number; last_answer_at: string | null }[]) {
    out[row.judge_id] = { answered: Number(row.answered), lastAnswerAt: row.last_answer_at };
  }
  return out;
};

/**
 * Leaderboard aggregated in SQL: never limited by row caps.
 * totalPoints is out of the session total (100): per question, the average of
 * the judges who answered it, summed over the questions.
 */
export const getLeaderboard = async (sessionId: string): Promise<LeaderboardEntry[]> => {
  const { data, error } = await supabase.rpc('session_leaderboard', { p_session_id: sessionId });
  if (error) throw error;
  return ((data || []) as {
    team_id: string; track: string | null; total_points: number; answer_count: number;
    judge_count: number; overall_rank: number; track_rank: number;
  }[]).map((r) => ({
    teamName: r.team_id,
    track: r.track ?? null,
    totalPoints: Number(r.total_points),
    answerCount: Number(r.answer_count),
    judgeCount: Number(r.judge_count),
    overallRank: Number(r.overall_rank),
    trackRank: Number(r.track_rank)
  }));
};

// ------------------------------------------------------------- Results ----

export const getSessionResults = async (sessionId: string): Promise<SessionResult[]> => {
  const { data, error } = await supabase
    .from('session_results')
    .select('*')
    .eq('session_id', sessionId)
    .order('total_points', { ascending: false });
  if (error) throw error;
  return data || [];
};

import { supabase } from './supabase';
import type { Team, Question, QuestionBank, Judge, Session, Answer, SessionResult } from '../types';

// Teams
export const getTeams = async (): Promise<Team[]> => {
  const { data, error } = await supabase
    .from('teams')
    .select('*')
    .order('display_order', { ascending: true })
    .order('name', { ascending: true });
  
  if (error) throw error;
  return data || [];
};

// Question Banks
export const getQuestionBanks = async (): Promise<QuestionBank[]> => {
  const { data, error } = await supabase
    .from('question_banks')
    .select('*')
    .order('name');
  
  if (error) throw error;
  return data || [];
};

// Questions
export const getQuestions = async (bankId?: string): Promise<Question[]> => {
  let query = supabase.from('questions').select('*');
  
  if (bankId) {
    query = query.eq('bank_id', bankId);
  }
  
  const { data, error } = await query.order('text');
  
  if (error) throw error;
  return data || [];
};

export const getQuestionsByBank = async (bankId: string): Promise<Question[]> => {
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .eq('bank_id', bankId)
    .order('text');
  
  if (error) throw error;
  return data || [];
};

// Sessions
export const createSession = async (sessionData: {
  name: string;
  session_id: string;
  host_token: string;
  host_id?: string;
  teams: string[];
  total_points: number;
}): Promise<Session> => {
  const { data, error } = await supabase
    .from('sessions')
    .insert(sessionData)
    .select()
    .single();
  
  if (error) throw error;
  return data;
};

/** All sessions owned by a given admin (newest first) */
export const getSessionsByHost = async (hostId: string): Promise<Session[]> => {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('host_id', hostId)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
};

export const getSession = async (sessionId: string): Promise<Session | null> => {const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('session_id', sessionId)
    .single();
  
  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    throw error;
  }
  return data;
};

export const updateSession = async (
  sessionId: string,
  updates: Partial<Session>
): Promise<Session> => {
  const { data, error } = await supabase
    .from('sessions')
    .update(updates)
    .eq('session_id', sessionId)
    .select()
    .single();
  
  if (error) throw error;
  return data;
};

export const deleteSession = async (sessionId: string): Promise<void> => {
  const { error } = await supabase
    .from('sessions')
    .delete()
    .eq('session_id', sessionId);
  
  if (error) throw error;
};

export const getLatestSession = async (): Promise<Session | null> => {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  
  if (error) {
    if (error.code === 'PGRST116') return null; // No sessions found
    throw error;
  }
  return data;
};

// Judges
export const createJudge = async (judgeData: {
  name: string;
  judge_token: string;
  session_id: string;
}): Promise<Judge> => {
  const { data, error } = await supabase
    .from('judges')
    .insert(judgeData)
    .select()
    .single();
  
  if (error) throw error;
  return data;
};

export const getOrCreateJudge = async (judgeData: {
  name: string;
  judge_token: string;
  session_id: string;
}): Promise<Judge> => {
  // First, try to find existing judge by name + session
  const { data: existing, error: findError } = await supabase
    .from('judges')
    .select('*')
    .eq('name', judgeData.name)
    .eq('session_id', judgeData.session_id)
    .maybeSingle();
  
  if (findError) throw findError;
  
  if (existing) {
    // Judge exists - update token and return
    const { data: updated, error: updateError } = await supabase
      .from('judges')
      .update({ judge_token: judgeData.judge_token })
      .eq('id', existing.id)
      .select()
      .single();
    
    if (updateError) throw updateError;
    console.log('✅ Reusing existing judge:', existing.name);
    return updated;
  }
  
  // Judge doesn't exist - create new
  console.log('✅ Creating new judge:', judgeData.name);
  return createJudge(judgeData);
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
    .single();
  
  if (error) {
    if (error.code === 'PGRST116') return null;
    throw error;
  }
  return data;
};

// Answers
export const submitAnswer = async (answerData: {
  answer: string;
  points?: number;
  question_id: string;
  team_id: string;
  judge_id: string;
  session_id: string;
}): Promise<Answer> => {
  const { data, error } = await supabase
    .from('answers')
    .insert(answerData)
    .select()
    .single();
  
  if (error) throw error;
  return data;
};

export const getAnswersBySession = async (sessionId: string): Promise<Answer[]> => {
  const { data, error } = await supabase
    .from('answers')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at');
  
  if (error) throw error;
  return data || [];
};

// Session Results
export const upsertSessionResult = async (resultData: {
  session_id: string;
  team_id: string;
  total_points: number;
  details: any;
}): Promise<SessionResult> => {
  const { data, error } = await supabase
    .from('session_results')
    .upsert(resultData, {
      onConflict: 'session_id,team_id'
    })
    .select()
    .single();
  
  if (error) throw error;
  return data;
};

export const getSessionResults = async (sessionId: string): Promise<SessionResult[]> => {
  const { data, error } = await supabase
    .from('session_results')
    .select('*')
    .eq('session_id', sessionId)
    .order('total_points', { ascending: false });
  
  if (error) throw error;
  return data || [];
};

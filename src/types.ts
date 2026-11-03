export type Outcome = 'merged' | 'completed' | 'abandoned' | 'failed' | 'unknown';

/**
 * How far to trust a session's duration. high: agent turn start and end times.
 * medium: gaps between messages. low: a start and end stamp only, which can
 * include days of the session sitting idle.
 */
export type SignalQuality = 'high' | 'medium' | 'low';

export interface Session {
  id: string;
  source: string;
  repo?: string;
  title?: string;
  /** Title and opening brief, for similarity. Stays in memory or the local cache. */
  text?: string;
  startedAt: number;
  endedAt: number;
  /** Time the agent was working. Absent when the source cannot tell. */
  activeMs?: number;
  signal: SignalQuality;
  model?: string;
  mode?: string;
  outcome: Outcome;
  briefChars: number;
  /** Declared work areas. 0 means not declared. */
  scopeCount: number;
  filesTouched?: number;
  retries?: number;
  tokens?: number;
  costUsd?: number;
}

export interface SessionSource {
  name: string;
  sessions(): AsyncIterable<Session>;
}

export type ExpectedSize = 'small' | 'medium' | 'large';

export interface Query {
  brief?: string;
  repo?: string;
  model?: string;
  scopeCount?: number;
  size?: ExpectedSize;
}

export type Confidence = 'low' | 'medium' | 'high';
export type ClassLevel = 'repo+model' | 'repo' | 'model' | 'global';

export interface Range {
  p50Ms: number;
  p80Ms: number;
  p95Ms: number;
}

export interface Comparable {
  id: string;
  title?: string;
  repo?: string;
  durationMs: number;
  similarity: number;
}

import type { Env } from '../config/env.js';
import type { GenerationSettings } from './types.js';

export type EffortLevel = 'light' | 'low' | 'medium' | 'high' | 'max';
export const effortLevels: EffortLevel[] = ['light', 'low', 'medium', 'high', 'max'];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (effortLevels as string[]).includes(value);
}

export function normalizeEffort(value: unknown, fallback: EffortLevel = 'medium'): EffortLevel {
  const level = typeof value === 'string' ? value.trim().toLowerCase() : value;
  return isEffortLevel(level) ? level : fallback;
}

function clampTimeout(ms: number): number {
  return Math.min(Math.max(Math.round(ms), 15000), 600000);
}

function validServerTimeout(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 15000 && value <= 600000 ? value : undefined;
}

// Reasoning params are sent only for non-medium effort so the default path
// stays byte-identical to previous behavior. Medium therefore never breaks
// models/gateways that reject unknown reasoning fields.
export function geminiThinkingLevel(effort: EffortLevel | undefined): 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | undefined {
  switch (effort) {
    case 'light': return 'MINIMAL';
    case 'low': return 'LOW';
    case 'high':
    case 'max': return 'HIGH';
    default: return undefined;
  }
}

export function chatReasoningEffort(effort: EffortLevel | undefined): 'minimal' | 'low' | 'medium' | 'high' | undefined {
  switch (effort) {
    case 'light': return 'minimal';
    case 'low': return 'low';
    case 'high':
    case 'max': return 'high';
    default: return undefined;
  }
}

// Anthropic-style extended thinking is opt-in: light/low/medium keep the
// previous thinking-disabled behavior, high/max enable a fixed budget.
export function messagesThinkingBudget(effort: EffortLevel | undefined): number | undefined {
  switch (effort) {
    case 'high': return 1024;
    case 'max': return 4096;
    default: return undefined;
  }
}

export function settingsForEffort(env: Env, effort: EffortLevel, serverTimeoutMs?: number): GenerationSettings {
  const level = normalizeEffort(effort, env.defaultEffort ?? 'medium');
  const base = validServerTimeout(serverTimeoutMs) ?? env.timeoutMs;
  const maxResponseChars = env.maxResponseChars;
  switch (level) {
    case 'light':
      return { timeoutMs: 30000, maxOutputTokens: 256, maxResponseChars, effort: level };
    case 'low':
      return { timeoutMs: 45000, maxOutputTokens: 512, maxResponseChars, effort: level };
    case 'medium':
      return { timeoutMs: clampTimeout(base), maxOutputTokens: env.maxOutputTokens, maxResponseChars, effort: level };
    case 'high':
      return { timeoutMs: clampTimeout(base * 2), maxOutputTokens: Math.min(env.maxOutputTokens * 2, 8192), maxResponseChars, effort: level };
    case 'max':
      return { timeoutMs: clampTimeout(Math.max(base * 3, 180000)), maxOutputTokens: 8192, maxResponseChars, effort: level };
  }
}

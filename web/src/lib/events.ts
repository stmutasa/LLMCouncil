import type { RunEvent } from '../../../shared/types';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

function isTurnLike(v: unknown): boolean {
  return isObject(v) && isString(v.id) && isString(v.status) && Array.isArray(v.rounds) && isString(v.finalText);
}

function isCallLike(v: unknown): boolean {
  return isObject(v) && isString(v.status) && isString(v.text);
}

/**
 * Parses one SSE `data:` payload. Returns null for anything that is not a well-formed run event
 * of a known type, so a malformed or future event can never corrupt the turn being displayed.
 */
export function parseRunEvent(data: string): RunEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(value) || !isString(value.type)) return null;
  const e = value;
  let ok: boolean;
  switch (e.type) {
    case 'snapshot':
    case 'turn.end':
      ok = isTurnLike(e.turn);
      break;
    case 'round.start':
      ok = isNumber(e.round);
      break;
    case 'member.start':
      ok = isNumber(e.round) && isString(e.memberId) && isString(e.startedAt);
      break;
    case 'member.delta':
      ok = isNumber(e.round) && isString(e.memberId) && isString(e.text) && isBool(e.replace);
      break;
    case 'member.activity':
      ok = isNumber(e.round) && isString(e.memberId) && isString(e.activity);
      break;
    case 'member.end':
      ok = isNumber(e.round) && isCallLike(e.response) && isString((e.response as Json).memberId);
      break;
    case 'round.end':
      ok = isNumber(e.round) && isObject(e.result) && Array.isArray(e.result.responses);
      break;
    case 'arbiter.start':
      ok = isString(e.startedAt);
      break;
    case 'arbiter.delta':
      ok = isString(e.text) && isBool(e.replace);
      break;
    case 'arbiter.activity':
      ok = isString(e.activity);
      break;
    case 'arbiter.end':
      ok = isCallLike(e.arbiter) && isString(e.analysisText) && isString(e.finalText);
      break;
    default:
      ok = false;
  }
  return ok ? (e as unknown as RunEvent) : null;
}

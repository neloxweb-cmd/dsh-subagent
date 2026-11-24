/**
 * Shared protocol constants, exit codes, error types, and validation helpers
 * for @local/dsh-subagent. Zero external dependencies, Node >= 20, ESM only.
 */

import { randomBytes } from 'node:crypto'

export const PACKAGE_NAME = '@local/dsh-subagent'
export const PACKAGE_VERSION = '2.0.1'
export const PROTOCOL_VERSION = 1

export const LOOPBACK_HOST = '127.0.0.1'
export const DEFAULT_BRIDGE_PORT = 45720
export const DEFAULT_WEB_PORT = 45721
export const DEFAULT_PROFILE_NAME = 'subagent'

export const MAX_BODY_BYTES = 2 * 1024 * 1024
export const DEFAULT_IDLE_TIMEOUT_SEC = 180
export const DEFAULT_TOOL_IDLE_TIMEOUT_SEC = 360
export const DEFAULT_MAX_TURN_SEC = 1800
export const DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS = 6
export const DEFAULT_POLL_WAIT_SEC = 25
export const MAX_POLL_WAIT_SEC = 60
export const DEFAULT_MAX_SESSIONS = 200

export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
export const SAFETY_MODES = Object.freeze(['readonly', 'workspace', 'full'])

export const RUN_STATUSES = Object.freeze([
  'running',
  'done',
  'needs_input',
  'stuck',
  'cancelled',
  'blocked_policy',
  'error',
])

export const TERMINAL_RUN_STATUSES = Object.freeze([
  'done',
  'needs_input',
  'stuck',
  'cancelled',
  'blocked_policy',
  'error',
])

export const SESSION_STATUSES = Object.freeze(['open', 'closed'])

/** Deterministic CLI exit codes so parent agents can branch cleanly. */
export const EXIT_CODES = Object.freeze({
  OK: 0,
  USAGE: 1,
  BRIDGE_DOWN: 2,
  UNAUTHORIZED: 3,
  ERROR: 4,
  NEEDS_INPUT: 10,
  STUCK: 11,
  CANCELLED: 12,
  POLICY_BLOCKED: 13,
})

const HTTP_STATUS_BY_CODE = Object.freeze({
  'bad-request': 400,
  unauthorized: 401,
  'not-found': 404,
  conflict: 409,
  'session-closed': 409,
  'turn-running': 409,
  'payload-too-large': 413,
  timeout: 504,
  'host-unavailable': 503,
  'turn-failed': 502,
  internal: 500,
})

export class SubagentError extends Error {
  /**
   * @param {string} code stable error code
   * @param {string} message human-readable explanation
   * @param {any} [details] optional structured diagnostics
   * @param {number} [status] HTTP status override
   */
  constructor(code, message, details = undefined, status = undefined) {
    super(message)
    this.name = 'SubagentError'
    this.code = code
    this.details = details
    this.status = status ?? HTTP_STATUS_BY_CODE[code] ?? 500
  }
}

export function statusForCode(code) {
  return HTTP_STATUS_BY_CODE[code] ?? 500
}

export function toSubagentError(error, fallbackCode = 'internal') {
  if (error instanceof SubagentError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new SubagentError(fallbackCode, message)
}

export function exitCodeForRunStatus(status) {
  switch (status) {
    case 'done':
      return EXIT_CODES.OK
    case 'needs_input':
      return EXIT_CODES.NEEDS_INPUT
    case 'stuck':
      return EXIT_CODES.STUCK
    case 'cancelled':
      return EXIT_CODES.CANCELLED
    case 'blocked_policy':
      return EXIT_CODES.POLICY_BLOCKED
    case 'error':
      return EXIT_CODES.ERROR
    default:
      return EXIT_CODES.ERROR
  }
}

export function nowIso() {
  return new Date().toISOString()
}

export function nowMs() {
  return Date.now()
}

export function newToken() {
  return randomBytes(32).toString('hex')
}

export function newRunId() {
  return 'run_' + randomBytes(8).toString('hex')
}

export function newTurnId() {
  return 'trn_' + randomBytes(6).toString('hex')
}

export function optionalString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export function requireString(value, field) {
  const s = optionalString(value)
  if (s === undefined) throw new SubagentError('bad-request', `"${field}" must be a non-empty string`)
  return s
}

export function requireEnum(value, allowed, field) {
  const s = requireString(value, field)
  if (!allowed.includes(s)) {
    throw new SubagentError('bad-request', `"${field}" must be one of: ${allowed.join(', ')}`)
  }
  return s
}

const VALID_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export function validateSessionName(value) {
  const name = requireString(value, 'name')
  if (!VALID_NAME_RE.test(name)) {
    throw new SubagentError(
      'bad-request',
      `"name" must start with a letter or digit and use only [a-zA-Z0-9._-] (max 64 chars), got "${name}"`,
    )
  }
  return name
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

export function cloneJson(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

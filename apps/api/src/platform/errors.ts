/**
 * The one error format (Part 6, API design): RFC 9457 problem details with a
 * machine-readable code. The codes match ErrorCode in openapi/domesday.yaml.
 */
export const ERROR_TITLES = {
  validation_failed: 'The request does not match the API specification',
  malformed_request: 'The request could not be read',
  unsupported_media_type: 'Unsupported content type',
  payload_too_large: 'The request body is too large',
  unauthenticated: 'Sign in first',
  mfa_required: 'Set up multi-factor authentication first',
  forbidden: 'Not allowed',
  not_found: 'Not found',
  conflict: 'Conflict',
  idempotency_key_required: 'An Idempotency-Key header is required',
  idempotency_key_reused: 'This Idempotency-Key was used for a different request',
  idempotency_request_in_progress: 'A request with this Idempotency-Key is still in progress',
  invalid_cursor: 'The cursor is not valid',
  rate_limited: 'Too many requests',
  not_implemented: 'Not built yet',
  internal_error: 'Something went wrong',
  fingerprint_mismatch: 'The clip does not match its fingerprint',
  clip_already_verified: 'The clip was already verified with another fingerprint',
  clip_already_rejected: 'The clip was rejected',
  upload_incomplete: 'The upload is incomplete',
  walk_not_ready_for_approval: 'The walk cannot be approved yet',
  capturer_cannot_approve: 'The person who filmed a room cannot approve its lines',
  bulk_approval_not_allowed: 'These lines cannot be approved in bulk',
  reason_required: 'A reason is required',
  retention_out_of_bounds: 'Retention must be between 13 months and 7 years',
  plan_limit_reached: 'The plan limit has been reached',
  partner_grant_inactive: 'Partner access is not active',
} as const;

export type ErrorCode = keyof typeof ERROR_TITLES;

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail: string;
  readonly requestId?: string;
  readonly [extra: string]: unknown;
}

export function problem(status: number, code: ErrorCode, detail: string, extra: Record<string, unknown> = {}): Problem {
  return { ...extra, type: `urn:domesday:problem:${code}`, title: ERROR_TITLES[code], status, code, detail };
}

/** Throw to stop a request with a problem response. The request's transaction is rolled back. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: ErrorCode;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: ErrorCode, detail: string, extra: Record<string, unknown> = {}) {
    super(detail);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  toProblem(requestId?: string): Problem {
    return problem(this.status, this.code, this.message, requestId ? { ...this.extra, requestId } : this.extra);
  }
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

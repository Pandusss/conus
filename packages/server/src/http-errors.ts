import { DomainError, type DomainErrorCode } from '@conus/core';

export function statusFor(code: DomainErrorCode): 400 | 401 | 403 | 404 | 409 {
  switch (code) {
    case 'validation': return 400;
    case 'unauthorized': return 401;
    case 'forbidden': return 403;
    case 'not_found': return 404;
    default: return 409; // invalid_transition, conflict_claimed, conflict_version
  }
}

export function toErrorResponse(e: unknown) {
  if (e instanceof DomainError) {
    return { status: statusFor(e.code), body: { error: { code: e.code, message: e.message, details: e.details } } };
  }
  if (e instanceof SyntaxError) {
    return { status: 400, body: { error: { code: 'validation', message: 'Invalid JSON body.' } } };
  }
  console.error('[server] unexpected error', e);
  return { status: 500, body: { error: { code: 'internal_error', message: 'Internal error.' } } };
}

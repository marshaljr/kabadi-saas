/**
 * Section 68: "Users should never see raw database errors... Log
 * technical details securely for developers." HttpError is the only
 * error type whose `.message` is safe to send to a client; anything
 * else gets logged server-side and replaced with a generic message
 * before it reaches a response body.
 */

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly publicCode?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * AuthError's `.code` distinguishes two genuinely different HTTP
 * situations that auth.service.ts's single error class covers:
 *   - the caller isn't authenticated at all, or their credentials/
 *     account are invalid → 401 Unauthorized
 *       (INVALID_CREDENTIALS, ACCOUNT_INACTIVE, EMAIL_TAKEN)
 *   - the caller IS authenticated (a valid token was presented) but
 *     isn't authorized for the specific business they asked for →
 *     403 Forbidden
 *       (NOT_A_MEMBER, MEMBERSHIP_INACTIVE)
 * Read via a duck-typed `.code` property rather than an `instanceof
 * AuthError` check, for the same reason as the `.name` check above:
 * this module must not import from modules/auth to avoid a
 * dependency cycle.
 */
function authErrorStatusCode(err: Error): number {
  const code = (err as { code?: unknown }).code;
  if (code === "NOT_A_MEMBER" || code === "MEMBERSHIP_INACTIVE") {
    return 403;
  }
  return 401;
}

export function toSafeErrorResponse(err: unknown): { statusCode: number; body: { error: string; code?: string } } {
  if (err instanceof HttpError) {
    return { statusCode: err.statusCode, body: { error: err.message, code: err.publicCode } };
  }

  // AuthError and ForbiddenError carry safe, user-facing messages by
  // design (see auth.service.ts / authorize.ts) — recognized by
  // duck-typed `.name` rather than importing them here, to avoid a
  // dependency cycle between lib/ and modules/.
  if (err instanceof Error && (err.name === "AuthError" || err.name === "ForbiddenError")) {
    const statusCode = err.name === "ForbiddenError" ? 403 : authErrorStatusCode(err);
    return { statusCode, body: { error: err.message } };
  }

  // BusinessError (modules/business/business.service.ts) is a client
  // input-validation problem (bad business name, unknown plan code),
  // not an auth failure — 400 Bad Request. Same duck-typed `.name`
  // approach, same no-import-cycle reason as above.
  if (err instanceof Error && err.name === "BusinessError") {
    return { statusCode: 400, body: { error: err.message } };
  }

  // Anything else is unexpected: log full details server-side, leak
  // nothing to the client.
  console.error("[unhandled error]", err);
  return { statusCode: 500, body: { error: "Something went wrong. Please try again." } };
}

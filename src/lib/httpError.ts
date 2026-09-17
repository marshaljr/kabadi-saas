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

export function toSafeErrorResponse(err: unknown): { statusCode: number; body: { error: string; code?: string } } {
  if (err instanceof HttpError) {
    return { statusCode: err.statusCode, body: { error: err.message, code: err.publicCode } };
  }

  // AuthError and ForbiddenError carry safe, user-facing messages by
  // design (see auth.service.ts / authorize.ts) — recognized by
  // duck-typed `.name` rather than importing them here, to avoid a
  // dependency cycle between lib/ and modules/.
  if (err instanceof Error && (err.name === "AuthError" || err.name === "ForbiddenError")) {
    const statusCode = err.name === "ForbiddenError" ? 403 : 401;
    return { statusCode, body: { error: err.message } };
  }

  // Anything else is unexpected: log full details server-side, leak
  // nothing to the client.
  console.error("[unhandled error]", err);
  return { statusCode: 500, body: { error: "Something went wrong. Please try again." } };
}

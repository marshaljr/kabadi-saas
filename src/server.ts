/**
 * Server: wires the authentication and Phase 2 SaaS-foundation
 * endpoints end-to-end over plain Node `http`, so it has zero
 * install-time dependencies beyond `pg` (which is only touched once a
 * request actually runs a query). Once dependencies can be installed,
 * swap this for Express/Fastify per section 56 — the route handlers
 * below are already factored as small async functions so that
 * migration is a mechanical wrapper change, not a rewrite.
 *
 * Endpoints:
 *   POST /api/auth/signup            { name, email, password }
 *   POST /api/auth/login             { email, password }
 *   GET  /api/auth/businesses        (Authorization: Bearer <identity token>)
 *   POST /api/auth/select-business   { businessId }  (Authorization: Bearer <identity token>)
 *   POST /api/businesses             { name, currencyCode?, languageCode?, timezone?, planCode? }
 *                                     (Authorization: Bearer <identity token>) — onboarding
 *   GET  /api/usage                  (Authorization: Bearer <business-scoped token>)
 *   GET  /api/admin/businesses       (Authorization: Bearer <identity token>, caller must be a platform admin)
 *   GET  /health
 *
 * Deliberately NOT duplicated here: a plain "GET /api/businesses" or
 * "POST /api/businesses/select" — those are exactly what
 * GET /api/auth/businesses and POST /api/auth/select-business already
 * do (Phase 1), so Phase 2 reuses those routes rather than adding
 * same-purpose aliases under a different prefix.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { env } from "./config/env.js";
import {
  AuthError,
  listMyBusinesses,
  login,
  selectActiveBusiness,
  signup,
  verifyBusinessScopedToken,
  verifyIdentityToken,
} from "./modules/auth/auth.service.js";
import { createBusiness, type CreateBusinessInput } from "./modules/business/business.service.js";
import { getUsageSummary } from "./modules/usage/usage.service.js";
import { listAllBusinesses, requirePlatformAdmin } from "./modules/admin/admin.service.js";
import { withTenantContext } from "./db/tenantContext.js";
import { toSafeErrorResponse } from "./lib/httpError.js";

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function getBearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    throw new AuthError(
      "Missing or malformed Authorization header",
      "INVALID_CREDENTIALS",
    );
  }
  return header.slice("Bearer ".length);
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const routes: Record<string, Record<string, Handler>> = {
  "/health": {
    GET: async (_req, res) => sendJson(res, 200, { status: "ok" }),
  },
  "/api/auth/signup": {
    POST: async (req, res) => {
      const body = await readJsonBody(req);
      const { name, email, password } = body as {
        name?: string;
        email?: string;
        password?: string;
      };
      if (!name || !email || !password) {
        throw new AuthError(
          "name, email and password are all required",
          "INVALID_CREDENTIALS",
        );
      }
      const result = await signup({ name, email, password });
      sendJson(res, 201, result);
    },
  },
  "/api/auth/login": {
    POST: async (req, res) => {
      const body = await readJsonBody(req);
      const { email, password } = body as { email?: string; password?: string };
      if (!email || !password) {
        throw new AuthError(
          "email and password are required",
          "INVALID_CREDENTIALS",
        );
      }
      const result = await login({ email, password });
      sendJson(res, 200, result);
    },
  },
  "/api/auth/businesses": {
    GET: async (req, res) => {
      const token = getBearerToken(req);
      const payload = verifyIdentityToken(token);
      const businesses = await listMyBusinesses(payload.sub);
      sendJson(res, 200, { businesses });
    },
  },
  "/api/auth/select-business": {
    POST: async (req, res) => {
      const token = getBearerToken(req);
      const payload = verifyIdentityToken(token);
      const body = await readJsonBody(req);
      const { businessId } = body as { businessId?: string };
      if (!businessId) {
        throw new AuthError("businessId is required", "NOT_A_MEMBER");
      }
      const result = await selectActiveBusiness(payload.sub, businessId);
      sendJson(res, 200, result);
    },
  },
  "/api/businesses": {
    POST: async (req, res) => {
      const token = getBearerToken(req);
      const payload = verifyIdentityToken(token);
      const body = await readJsonBody(req);
      const { name, currencyCode, languageCode, timezone, planCode } = body as Partial<CreateBusinessInput>;

      // Deliberately NOT validated here with an AuthError/early-return:
      // a missing/blank business name is a request-validation problem,
      // not an authentication problem, and must map to 400 Bad Request,
      // not 401. createBusinessTx's own BusinessError("NAME_REQUIRED")
      // check (business.service.ts) is the single source of truth for
      // this validation — routed here so there is exactly one place
      // that decides what counts as a valid name, and so the same rule
      // applies to any other future caller of createBusiness that isn't
      // this HTTP route. The `typeof` guard below only exists to
      // satisfy CreateBusinessInput's `name: string` type at this
      // boundary (a request body can contain anything, including a
      // non-string name) — it does not weaken the validation itself.
      const result = await createBusiness(payload.sub, {
        name: typeof name === "string" ? name : "",
        currencyCode,
        languageCode,
        timezone,
        planCode,
      });

      // Reuses the existing selectActiveBusiness foundation (Phase 1)
      // rather than minting a business-scoped token here directly, so
      // the newly onboarded business immediately becomes usable
      // without a second round-trip, and so there is exactly one code
      // path that ever issues a business-scoped token.
      const session = await selectActiveBusiness(payload.sub, result.business.id);

      sendJson(res, 201, { ...result, accessToken: session.accessToken });
    },
  },
  "/api/usage": {
    GET: async (req, res) => {
      const token = getBearerToken(req);
      const payload = verifyBusinessScopedToken(token);
      const usage = await withTenantContext(payload.sub, payload.businessId, (client) => getUsageSummary(client, payload.businessId));
      sendJson(res, 200, usage);
    },
  },
  "/api/admin/businesses": {
    GET: async (req, res) => {
      const token = getBearerToken(req);
      const payload = verifyIdentityToken(token);
      await requirePlatformAdmin(payload.sub);
      const businesses = await listAllBusinesses(payload.sub);
      sendJson(res, 200, { businesses });
    },
  },
};

export const server = createServer((req, res) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const routeHandlers = routes[url.pathname];
  const handler = routeHandlers?.[req.method ?? "GET"];

  if (!handler) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  handler(req, res).catch((err) => {
    const { statusCode, body } = toSafeErrorResponse(err);
    sendJson(res, statusCode, body);
  });
});

const isMainModule =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  server.listen(env.port, () => {
    console.log(`kabadi-saas API listening on :${env.port}`);
  });
}

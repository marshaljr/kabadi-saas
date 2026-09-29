/**
 * Phase 1 server: wires the authentication foundation end-to-end
 * over plain Node `http`, so it has zero install-time dependencies
 * beyond `pg` (which is only touched once a request actually runs a
 * query). Once dependencies can be installed, swap this for
 * Express/Fastify per section 56 — the route handlers below are
 * already factored as small async functions so that migration is a
 * mechanical wrapper change, not a rewrite.
 *
 * Endpoints (Phase 1 scope — see auth.service.ts for what's
 * deliberately NOT included yet, e.g. business creation/onboarding):
 *   POST /api/auth/signup            { name, email, password }
 *   POST /api/auth/login             { email, password }
 *   GET  /api/auth/businesses        (Authorization: Bearer <identity token>)
 *   POST /api/auth/select-business   { businessId }  (Authorization: Bearer <identity token>)
 *   GET  /health
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
  verifyIdentityToken,
} from "./modules/auth/auth.service.js";
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

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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import { toSafeErrorResponse } from "./lib/httpError.js";
import {
  createBusiness,
  getUsage,
  listPlans,
  listPlatformBusinesses,
} from "./modules/business/business.service.js";
import {
  createCategory, createCustomer, createMaterial, createPaymentMethod, createSupplier, createWorker,
  listCategories, listCustomers, listMaterials, listPaymentMethods, listSuppliers, listWorkers,
} from "./modules/people/people.service.js";
import { createPurchase, listPurchases } from "./modules/purchases/purchase.service.js";
import { createSale, listSales } from "./modules/sales/sale.service.js";
import { createAdjustment, getInventory } from "./modules/inventory/inventory.service.js";

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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
    throw new AuthError("Missing or malformed Authorization header", "INVALID_CREDENTIALS");
  }

  return header.slice("Bearer ".length);
}

function tenantArgs(req: IncomingMessage) {
  const payload = verifyBusinessScopedToken(getBearerToken(req));
  return { userId: payload.sub, businessId: payload.businessId, roleId: payload.roleId };
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
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
      const { name, email, password } = body as { name?: string; email?: string; password?: string };
      if (!name || !email || !password) {
        throw new AuthError("name, email and password are all required", "INVALID_CREDENTIALS");
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
        throw new AuthError("email and password are required", "INVALID_CREDENTIALS");
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
  "/api/auth/switch-business": {
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
      const result = await createBusiness(payload.sub, {
        name: String(body.name ?? ""),
        address: typeof body.address === "string" ? body.address : undefined,
        phone: typeof body.phone === "string" ? body.phone : undefined,
        email: typeof body.email === "string" ? body.email : undefined,
        planCode: typeof body.planCode === "string" ? body.planCode : undefined,
      });
      sendJson(res, 201, result);
    },
  },
  "/api/usage": {
    GET: async (req, res) => {
      const token = getBearerToken(req);
      const payload = verifyBusinessScopedToken(token);
      const usage = await getUsage(payload.sub, payload.businessId, payload.roleId);
      sendJson(res, 200, { usage });
    },
  },
  "/api/plans": {
    GET: async (_req, res) => {
      sendJson(res, 200, { plans: await listPlans() });
    },
  },
  "/api/platform/businesses": {
    GET: async (req, res) => {
      const token = getBearerToken(req);
      const payload = verifyIdentityToken(token);
      const businesses = await listPlatformBusinesses(payload.sub);
      sendJson(res, 200, { businesses });
    },
  },
  "/api/categories": {
    GET: async (req, res) => sendJson(res, 200, { categories: await listCategories(tenantArgs(req)) }),
    POST: async (req, res) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, { category: await createCategory(tenantArgs(req), String(body.name ?? ""), typeof body.description === "string" ? body.description : undefined) });
    },
  },
  "/api/materials": {
    GET: async (req, res) => sendJson(res, 200, { materials: await listMaterials(tenantArgs(req)) }),
    POST: async (req, res) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, { material: await createMaterial(tenantArgs(req), {
        categoryId: String(body.categoryId ?? ""), name: String(body.name ?? ""),
        sku: typeof body.sku === "string" ? body.sku : undefined,
        defaultUnit: typeof body.defaultUnit === "string" ? body.defaultUnit : undefined,
        minimumStock: typeof body.minimumStock === "number" ? body.minimumStock : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
      }) });
    },
  },
  "/api/workers": {
    GET: async (req, res) => sendJson(res, 200, { workers: await listWorkers(tenantArgs(req)) }),
    POST: async (req, res) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, { worker: await createWorker(tenantArgs(req), {
        name: String(body.name ?? ""), workerCode: typeof body.workerCode === "string" ? body.workerCode : undefined,
        phone: typeof body.phone === "string" ? body.phone : undefined, address: typeof body.address === "string" ? body.address : undefined,
        joiningDate: typeof body.joiningDate === "string" ? body.joiningDate : undefined, notes: typeof body.notes === "string" ? body.notes : undefined,
      }) });
    },
  },
  "/api/customers": {
    GET: async (req, res) => sendJson(res, 200, { customers: await listCustomers(tenantArgs(req)) }),
    POST: async (req, res) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, { customer: await createCustomer(tenantArgs(req), {
        name: String(body.name ?? ""), customerCode: typeof body.customerCode === "string" ? body.customerCode : undefined,
        phone: typeof body.phone === "string" ? body.phone : undefined, address: typeof body.address === "string" ? body.address : undefined,
      }) });
    },
  },
  "/api/suppliers": {
    GET: async (req, res) => sendJson(res, 200, { suppliers: await listSuppliers(tenantArgs(req)) }),
    POST: async (req, res) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, { supplier: await createSupplier(tenantArgs(req), {
        name: String(body.name ?? ""), supplierCode: typeof body.supplierCode === "string" ? body.supplierCode : undefined,
        phone: typeof body.phone === "string" ? body.phone : undefined, address: typeof body.address === "string" ? body.address : undefined,
      }) });
    },
  },
  "/api/payment-methods": {
    GET: async (req, res) => sendJson(res, 200, { paymentMethods: await listPaymentMethods(tenantArgs(req)) }),
    POST: async (req, res) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, { paymentMethod: await createPaymentMethod(tenantArgs(req), String(body.name ?? ""), body.isCash === true) });
    },
  },
  "/api/purchases": {
    GET: async (req, res) => sendJson(res, 200, { purchases: await listPurchases(tenantArgs(req)) }),
    POST: async (req, res) => {
      const body = await readJsonBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      sendJson(res, 201, { result: await createPurchase(tenantArgs(req), {
        purchaseNo: String(body.purchaseNo ?? ""),
        workerId: typeof body.workerId === "string" ? body.workerId : undefined,
        supplierId: typeof body.supplierId === "string" ? body.supplierId : undefined,
        date: typeof body.date === "string" ? body.date : undefined,
        discount: typeof body.discount === "number" ? body.discount : undefined,
        taxAmount: typeof body.taxAmount === "number" ? body.taxAmount : undefined,
        paidAmount: typeof body.paidAmount === "number" ? body.paidAmount : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
        items: items.map((item) => ({
          materialId: String((item as Record<string, unknown>).materialId ?? ""),
          quantity: Number((item as Record<string, unknown>).quantity ?? 0),
          unit: String((item as Record<string, unknown>).unit ?? "KG"),
          unitPrice: Number((item as Record<string, unknown>).unitPrice ?? 0),
          notes: typeof (item as Record<string, unknown>).notes === "string" ? (item as Record<string, unknown>).notes as string : undefined,
        })),
      }) });
    },
  },
  "/api/sales": {
    GET: async (req, res) => sendJson(res, 200, { sales: await listSales(tenantArgs(req)) }),
    POST: async (req, res) => {
      const body = await readJsonBody(req);
      const items = Array.isArray(body.items) ? body.items : [];
      sendJson(res, 201, { result: await createSale(tenantArgs(req), {
        saleNo: String(body.saleNo ?? ""),
        customerId: typeof body.customerId === "string" ? body.customerId : undefined,
        date: typeof body.date === "string" ? body.date : undefined,
        discount: typeof body.discount === "number" ? body.discount : undefined,
        taxAmount: typeof body.taxAmount === "number" ? body.taxAmount : undefined,
        paidAmount: typeof body.paidAmount === "number" ? body.paidAmount : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
        items: items.map((item) => {
          const value = item as Record<string, unknown>;
          return { materialId: String(value.materialId ?? ""), quantity: Number(value.quantity ?? 0), unit: String(value.unit ?? "KG"), unitPrice: Number(value.unitPrice ?? 0) };
        }),
      }) });
    },
  },
  "/api/inventory": {
    GET: async (req, res) => sendJson(res, 200, { inventory: await getInventory(tenantArgs(req)) }),
    POST: async (req, res) => {
      const body = await readJsonBody(req);
      sendJson(res, 201, { movement: await createAdjustment(tenantArgs(req), {
        materialId: String(body.materialId ?? ""), quantity: Number(body.quantity ?? 0),
        unit: String(body.unit ?? "KG"), unitCost: Number(body.unitCost ?? 0),
        direction: body.direction === "OUT" ? "OUT" : "IN",
        notes: typeof body.notes === "string" ? body.notes : undefined,
      }) });
    },
  },
};

export const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
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

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  server.listen(env.port, () => {
    console.log(`kabadi-saas API listening on :${env.port}`);
  });
}

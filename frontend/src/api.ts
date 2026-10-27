export type ApiError = Error & { status?: number; code?: string };
export type Dashboard = {
  dateRange: { from: string | null; to: string | null };
  purchases: { count: number; total: string };
  sales: { count: number; total: string; revenue: string };
  financial: { revenue: string; cogs: string; grossProfit: string; operatingExpenses: string; netProfit: string };
  inventory: { quantity: string; value: string; low_stock: number };
  workers: { count: number };
};
export type Pnl = Dashboard["financial"] & { salesRevenue: string; otherIncome: string; breakdown: Array<{ name: string; type: string; debit: string; credit: string }> };
export type User = { id: string; name: string; email: string };
export type Business = { businessId?: string; id?: string; businessName?: string; name?: string; roleName?: string };
export type Worker = { id: string; name: string; worker_code?: string; phone?: string; address?: string; payable_balance?: string; advance_balance?: string };
export type Category = { id: string; name: string };
export type Material = { id: string; name: string; category_id: string; default_unit: string; current_purchase_rate?: string; minimum_stock?: string };
export type PurchaseItem = { id?: string; material_id?: string; quantity: string | number; unit: string; unit_price?: string | number; amount?: string | number };
export type Purchase = { id: string; purchase_no: string; worker_id?: string; date: string; subtotal: string; discount: string; tax_amount: string; total_amount: string; paid_amount: string; due_amount: string; items: PurchaseItem[] };
export type WorkerProfile = { worker: Worker; summary: { totalPurchased: string; totalPaid: string; outstanding: string; totalCollections: number }; collections: Purchase[] };
export type PurchaseInput = { purchaseNo: string; workerId: string; date?: string; discount?: number; taxAmount?: number; paidAmount?: number; notes?: string; items: Array<{ materialId: string; quantity: number; unit: string; unitPrice: number }> };

const base = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const identityKey = "kabadi.identityToken";
const accessKey = "kabadi.accessToken";

export function getDraftScope(): string {
  const token = localStorage.getItem(accessKey);
  if (!token) return "unknown";
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    return `${payload.userId ?? payload.sub ?? "user"}.${payload.businessId ?? "business"}`;
  } catch { return "unknown"; }
}

async function request<T>(path: string, options: RequestInit = {}, token = localStorage.getItem(accessKey) ?? localStorage.getItem(identityKey)): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? "Request failed") as ApiError;
    error.status = response.status; error.code = body.code;
    if (response.status === 401) { localStorage.removeItem(identityKey); localStorage.removeItem(accessKey); }
    throw error;
  }
  return body as T;
}

export const api = {
  login: (email: string, password: string) => request<{ user: User; identityToken: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }, null),
  signup: (name: string, email: string, password: string) => request<{ user: User; identityToken: string }>("/api/auth/signup", { method: "POST", body: JSON.stringify({ name, email, password }) }, null),
  businesses: () => request<{ businesses: Business[] }>("/api/auth/businesses", {}, localStorage.getItem(identityKey)),
  selectBusiness: (businessId: string) => request<{ accessToken: string; roleName: string }>("/api/auth/select-business", { method: "POST", body: JSON.stringify({ businessId }) }, localStorage.getItem(identityKey)),
  createBusiness: (input: Record<string, string>) => request<{ business: Business; accessToken: string }>("/api/businesses", { method: "POST", body: JSON.stringify(input) }, localStorage.getItem(identityKey)),
  dashboard: (from?: string, to?: string) => request<{ dashboard: Dashboard }>(`/api/reports/dashboard?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`),
  pnl: (from?: string, to?: string) => request<{ report: Pnl }>(`/api/reports/profit-loss?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) })}`),
  workers: () => request<{ workers: Worker[] }>("/api/workers"),
  workerProfile: (workerId: string) => request<{ profile: WorkerProfile }>(`/api/worker-profile?workerId=${encodeURIComponent(workerId)}`),
  materials: () => request<{ materials: Material[] }>("/api/materials"),
  categories: () => request<{ categories: Category[] }>("/api/categories"),
  createCategory: (name: string) => request<{ category: Category }>("/api/categories", { method: "POST", body: JSON.stringify({ name }) }),
  createMaterial: (input: { name: string; categoryId: string; defaultUnit: string; minimumStock?: number; notes?: string }) => request<{ material: Material }>("/api/materials", { method: "POST", body: JSON.stringify(input) }),
  createWorker: (input: { name: string; workerCode?: string; phone?: string; address?: string }) => request<{ worker: Worker }>("/api/workers", { method: "POST", body: JSON.stringify(input) }),
  createPurchase: (input: PurchaseInput) => request<{ result: { purchase: Purchase; items: PurchaseItem[] } }>("/api/purchases", { method: "POST", body: JSON.stringify(input) }),
  usage: () => request<{ usage: Array<Record<string, string | number | null>> }>("/api/usage"),
  subscription: () => request<{ subscription: Record<string, unknown> | null }>("/api/billing/subscription"),
  list: (resource: string) => request<Record<string, unknown[]>>(`/api/${resource}`),
  create: (resource: string, input: unknown) => request<Record<string, unknown>>(`/api/${resource}`, { method: "POST", body: JSON.stringify(input) }),
};

export function saveIdentity(token: string) { localStorage.setItem(identityKey, token); }
export function saveAccess(token: string) { localStorage.setItem(accessKey, token); }
export function hasIdentity() { return Boolean(localStorage.getItem(identityKey)); }
export function signOut() { localStorage.removeItem(identityKey); localStorage.removeItem(accessKey); }

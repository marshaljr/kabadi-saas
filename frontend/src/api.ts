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

const base = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";
const identityKey = "kabadi.identityToken";
const accessKey = "kabadi.accessToken";

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
  usage: () => request<{ usage: Array<Record<string, string | number | null>> }>("/api/usage"),
  subscription: () => request<{ subscription: Record<string, unknown> | null }>("/api/billing/subscription"),
  list: (resource: string) => request<Record<string, unknown[]>>(`/api/${resource}`),
  create: (resource: string, input: unknown) => request<Record<string, unknown>>(`/api/${resource}`, { method: "POST", body: JSON.stringify(input) }),
};
export type User = { id: string; name: string; email: string };
export type Business = { businessId?: string; id?: string; businessName?: string; name?: string; roleName?: string };
export function saveIdentity(token: string) { localStorage.setItem(identityKey, token); }
export function saveAccess(token: string) { localStorage.setItem(accessKey, token); }
export function hasIdentity() { return Boolean(localStorage.getItem(identityKey)); }
export function signOut() { localStorage.removeItem(identityKey); localStorage.removeItem(accessKey); }

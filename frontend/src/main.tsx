import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, Business, Dashboard, hasIdentity, Pnl, saveAccess, saveIdentity, signOut } from "./api";
import "./styles.css";

const money = (value: string | number | undefined) => `NPR ${Number(value ?? 0).toLocaleString("en-NP", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const draftKey = (business: string) => `kabadi.drafts.${business}`;

function Auth({ onReady }: { onReady: () => void }) {
  const [signup, setSignup] = useState(false); const [name, setName] = useState(""); const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  async function submit(event: React.FormEvent) { event.preventDefault(); setError(""); try { const result = signup ? await api.signup(name, email, password) : await api.login(email, password); saveIdentity(result.identityToken); onReady(); } catch (err) { setError((err as Error).message); } }
  return <main className="auth-shell"><section className="auth-card"><div className="brand-mark">K</div><p className="eyebrow">KABADI DESK · NEPAL</p><h1>{signup ? "Start your collection desk" : "Welcome back"}</h1><p className="muted">{signup ? "Run collections, stock, sales, and accounts from one calm workspace." : "Sign in to continue to your business workspace."}</p><form onSubmit={submit}>{signup && <label>Full name<input required value={name} onChange={e => setName(e.target.value)} /></label>}<label>Email<input required type="email" value={email} onChange={e => setEmail(e.target.value)} /></label><label>Password<input required minLength={8} type="password" value={password} onChange={e => setPassword(e.target.value)} /></label>{error && <div className="alert danger">{error}</div>}<button className="primary full">{signup ? "Create account" : "Sign in"}</button></form><button className="link-button" onClick={() => setSignup(!signup)}>{signup ? "Already have an account? Sign in" : "Create a new account"}</button></section></main>;
}

function Setup({ onReady }: { onReady: () => void }) {
  const [businesses, setBusinesses] = useState<Business[]>([]); const [name, setName] = useState(""); const [error, setError] = useState("");
  useEffect(() => { api.businesses().then(r => setBusinesses(r.businesses)).catch(e => setError(e.message)); }, []);
  async function choose(id: string) { try { const result = await api.selectBusiness(id); saveAccess(result.accessToken); onReady(); } catch (e) { setError((e as Error).message); } }
  async function create(e: React.FormEvent) { e.preventDefault(); try { const result = await api.createBusiness({ name, planCode: "FREE" }); saveAccess(result.accessToken); onReady(); } catch (err) { setError((err as Error).message); } }
  return <main className="auth-shell"><section className="auth-card wide"><p className="eyebrow">BUSINESS SETUP</p><h1>Choose your workspace</h1>{businesses.length > 0 && <div className="business-list">{businesses.map(b => <button className="business-choice" key={b.businessId} onClick={() => choose(b.businessId!)}><strong>{b.businessName}</strong><span>{b.roleName}</span><span>→</span></button>)}</div>}<div className="divider"><span>or create a new business</span></div><form onSubmit={create}><label>Business name<input required value={name} onChange={e => setName(e.target.value)} placeholder="Kathmandu Kabadi" /></label>{error && <div className="alert danger">{error}</div>}<button className="primary full">Create FREE workspace</button></form></section></main>;
}

function App() {
  const [authenticated, setAuthenticated] = useState(hasIdentity()); const [businessReady, setBusinessReady] = useState(Boolean(localStorage.getItem("kabadi.accessToken")));
  if (!authenticated) return <Auth onReady={() => setAuthenticated(true)} />;
  if (!businessReady) return <Setup onReady={() => setBusinessReady(true)} />;
  return <Workspace onSignOut={() => { signOut(); setAuthenticated(false); setBusinessReady(false); }} />;
}

function Workspace({ onSignOut }: { onSignOut: () => void }) {
  const [page, setPage] = useState("dashboard"); const [dashboard, setDashboard] = useState<Dashboard>(); const [pnl, setPnl] = useState<Pnl>(); const [error, setError] = useState("");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  useEffect(() => { api.dashboard().then(r => setDashboard(r.dashboard)).catch(e => setError(e.message)); }, []);
  useEffect(() => { if (page === "reports") api.pnl(from || undefined, to || undefined).then(r => setPnl(r.report)).catch(e => setError(e.message)); }, [page, from, to]);
  const nav: Array<[string, string]> = [["dashboard", "Overview"], ["collections", "Collections"], ["workers", "Workers"], ["materials", "Materials"], ["sales", "Sales"], ["inventory", "Inventory"], ["accounting", "Accounting"], ["reports", "Reports"], ["billing", "Plan & usage"]];
  return <div className="app-shell"><aside><div className="side-brand"><div className="brand-mark small">K</div><div><strong>Kabadi Desk</strong><small>Nepal operations</small></div></div><nav>{nav.map(([id, label]) => <button className={page === id ? "active" : ""} key={id} onClick={() => setPage(id)}><span className={`nav-icon ${id}`} />{label}</button>)}</nav><div className="side-footer"><button onClick={onSignOut}>Sign out</button><small>Asia/Kathmandu · NPR</small></div></aside><main className="content"><header><div><p className="eyebrow">KATHMANDU WORKSPACE</p><h2>{nav.find(n => n[0] === page)?.[1] ?? "Overview"}</h2></div><div className="header-actions"><span className="status-dot">Live</span><button className="icon-button" onClick={() => { localStorage.removeItem("kabadi.accessToken"); location.reload(); }}>Switch</button></div></header>{error && <div className="alert danger">{error}</div>}{page === "dashboard" && <DashboardPage dashboard={dashboard} onDate={(f, t) => { setFrom(f); setTo(t); api.dashboard(f || undefined, t || undefined).then(r => setDashboard(r.dashboard)).catch(e => setError(e.message)); }} />}{page === "reports" && <ReportsPage pnl={pnl} from={from} to={to} setFrom={setFrom} setTo={setTo} />}{["collections", "workers", "materials", "sales", "inventory", "accounting", "billing"].includes(page) && <ResourcePage resource={page} />}</main></div>;
}

function DashboardPage({ dashboard, onDate }: { dashboard?: Dashboard; onDate: (from: string, to: string) => void }) {
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  if (!dashboard) return <Loading />;
  return <><div className="toolbar"><span className="muted">Period metrics · inventory and workers are current snapshots</span><div className="date-filter"><input type="date" value={from} onChange={e => setFrom(e.target.value)} /><span>to</span><input type="date" value={to} onChange={e => setTo(e.target.value)} /><button className="secondary" onClick={() => onDate(from, to)}>Apply</button></div></div><section className="metric-grid">{[["Sales revenue", money(dashboard.financial.revenue), "period"], ["Gross profit", money(dashboard.financial.grossProfit), "period"], ["Net profit", money(dashboard.financial.netProfit), "period"], ["Operating expenses", money(dashboard.financial.operatingExpenses), "period"]].map(([label, value, note]) => <article className="metric-card" key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>)}</section><section className="dashboard-grid"><article className="panel"><div className="panel-heading"><div><p className="eyebrow">INVENTORY SNAPSHOT</p><h3>Stock on hand</h3></div><span className="pill warning">{dashboard.inventory.low_stock} low stock</span></div><div className="big-number">{dashboard.inventory.quantity} <small>units</small></div><p className="muted">Estimated value {money(dashboard.inventory.value)}</p></article><article className="panel"><div className="panel-heading"><div><p className="eyebrow">OPERATIONS</p><h3>This period</h3></div></div><div className="stat-list"><div><span>Purchases</span><strong>{dashboard.purchases.count} · {money(dashboard.purchases.total)}</strong></div><div><span>Sales</span><strong>{dashboard.sales.count} · {money(dashboard.sales.total)}</strong></div><div><span>Active workers</span><strong>{dashboard.workers.count}</strong></div></div></article></section></>;
}

function ReportsPage({ pnl, from, to, setFrom, setTo }: { pnl?: Pnl; from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void }) {
  return <><div className="toolbar"><div><p className="muted">Posted journals only · other income shown separately</p></div><div className="date-filter"><input type="date" value={from} onChange={e => setFrom(e.target.value)} /><span>to</span><input type="date" value={to} onChange={e => setTo(e.target.value)} /></div></div>{!pnl ? <Loading /> : <><section className="metric-grid">{[["Sales revenue", pnl.salesRevenue], ["COGS", pnl.cogs], ["Gross profit", pnl.grossProfit], ["Expenses", pnl.operatingExpenses], ["Other income", pnl.otherIncome], ["Net profit", pnl.netProfit]].map(([label, value]) => <article className="metric-card" key={label}><span>{label}</span><strong>{money(value)}</strong></article>)}</section><article className="panel table-panel"><div className="panel-heading"><h3>Account breakdown</h3></div><Table columns={["Account", "Type", "Debit", "Credit"]} rows={pnl.breakdown.map(row => [row.name, row.type, money(row.debit), money(row.credit)])} /></article></>}</>;
}

function ResourcePage({ resource }: { resource: string }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [name, setName] = useState(""); const [notice, setNotice] = useState("");
  const config: Record<string, { title: string; endpoint: string; label: string; fields: string[] }> = {
    collections: { title: "Collections", endpoint: "purchases", label: "Purchase", fields: ["purchase_no", "date", "total_amount", "paid_amount", "due_amount"] },
    workers: { title: "Workers", endpoint: "workers", label: "Worker", fields: ["name", "worker_code", "phone"] },
    materials: { title: "Materials", endpoint: "materials", label: "Material", fields: ["name", "sku", "default_unit", "minimum_stock"] },
    sales: { title: "Sales", endpoint: "sales", label: "Sale", fields: ["sale_no", "date", "total_amount", "paid_amount", "due_amount"] },
    inventory: { title: "Inventory", endpoint: "inventory", label: "Stock", fields: ["name", "quantity_on_hand", "average_cost", "low_stock"] },
    accounting: { title: "Accounting", endpoint: "accounting/ledger", label: "Journal entry", fields: ["entry_no", "date", "account_name", "debit", "credit"] },
    billing: { title: "Plan & usage", endpoint: "usage", label: "Usage", fields: ["metric", "value", "max_users", "max_workers", "max_monthly_transactions"] },
  };
  const current = config[resource]!;
  useEffect(() => { setLoading(true); api.list(current.endpoint).then(result => { const first = Object.values(result)[0]; setRows(Array.isArray(first) ? first as Record<string, unknown>[] : []); }).catch(e => setError(e.message)).finally(() => setLoading(false)); }, [resource]);
  async function add(e: React.FormEvent) { e.preventDefault(); if (!name.trim()) return; try { if (resource === "workers") await api.create("workers", { name }); else { const drafts = JSON.parse(localStorage.getItem(draftKey("current")) ?? "[]"); drafts.push({ resource, name, createdAt: new Date().toISOString(), draft: true }); localStorage.setItem(draftKey("current"), JSON.stringify(drafts)); setNotice("Saved as a local draft. This has not been posted to the server."); } setName(""); if (resource === "workers") { const result = await api.list(current.endpoint); setRows(Object.values(result)[0] as Record<string, unknown>[]); } } catch (err) { setError((err as Error).message); } }
  return <><div className="toolbar"><div><p className="muted">{resource === "collections" ? "Start a worker collection, hold it, and post only when complete." : "Real tenant data from the backend API."}</p></div>{["workers", "collections"].includes(resource) && <form className="quick-add" onSubmit={add}><input value={name} onChange={e => setName(e.target.value)} placeholder={`${current.label} name`} /><button className="primary">Add</button></form>}</div>{notice && <div className="alert success">{notice}</div>}{error && <div className="alert danger">{error}</div>}{loading ? <Loading /> : <article className="panel table-panel"><div className="panel-heading"><h3>{current.title}</h3><span className="muted">{rows.length} records</span></div>{rows.length ? <Table columns={current.fields.map(f => f.replaceAll("_", " "))} rows={rows.map(row => current.fields.map(field => String(row[field] ?? "—"))) } /> : <Empty title={`No ${current.title.toLowerCase()} yet`} text="Records created in this workspace will appear here." />}</article>}</>;
}

function Table({ columns, rows }: { columns: string[]; rows: string[][] }) { return <div className="table-scroll"><table><thead><tr>{columns.map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>; }
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><div className="empty-icon">○</div><h3>{title}</h3><p>{text}</p></div>; }
function Loading() { return <div className="loading"><span />Loading workspace data…</div>; }
createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);

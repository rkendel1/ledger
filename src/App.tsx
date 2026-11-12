/**
 * The application shell: sign-in and organization screens (FeltKit's own), first-run setup, navigation.
 */
import { useMemo, type ReactNode } from "react";
import { AcceptInvitation, AuthNotices, CreateTenant, SignIn, TenantSwitcher, useAuth, useAuthRedirect, useTenant } from "@feltdb/feltkit/react";
import { api, CurrencyContext, Loading, PermissionsContext, Toasts, useQuery, useRoute } from "./lib";
import { Setup } from "./pages/Setup";
import { Overview } from "./pages/Overview";
import { Banking } from "./pages/Banking";
import { Transactions } from "./pages/Transactions";
import { Invoices } from "./pages/Invoices";
import { Bills } from "./pages/Bills";
import { Expenses } from "./pages/Expenses";
import { Accounting } from "./pages/Accounting";
import { Reports } from "./pages/Reports";
import { Activity } from "./pages/Activity";
import { Settings } from "./pages/Settings";

const NAV: Array<[string, string, string]> = [
  ["overview", "Overview", "M3 12l9-8 9 8M5 10v10h14V10"],
  ["banking", "Banking", "M3 10h18M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18M12 3l9 5H3z"],
  ["transactions", "Transactions", "M4 6h16M4 12h16M4 18h10"],
  ["invoices", "Invoices", "M7 3h10v18l-3-2-2 2-2-2-3 2zM9 8h6M9 12h6"],
  ["bills", "Bills", "M6 3h12v18H6zM9 8h6M9 12h6M9 16h3"],
  ["expenses", "Expenses", "M4 7h16v12H4zM4 11h16M8 15h3"],
  ["accounting", "Accounting", "M4 4h16v16H4zM4 10h16M10 4v16"],
  ["reports", "Reports", "M5 20V10M12 20V4M19 20v-7"],
  ["activity", "Activity", "M3 12h4l3-8 4 16 3-8h4"],
  ["settings", "Settings", "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 1-2-2V4h-4v2L9 7 7 6 5 10l2 1v2l-2 1 2 4 2-1 2 2v2h4v-2l2-2 2 1 2-4-2-1z"],
];

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

export function App() {
  const auth = useAuth();
  const tenant = useTenant();
  const { redirect } = useAuthRedirect();
  if (auth.loading) return <Loading />;
  if (redirect?.kind === "invitation") return <Centered><AcceptInvitation /></Centered>;
  if (!auth.user) return <Centered><SignIn brand={{ name: "Ledger" }} /></Centered>;
  if (!tenant.current) return <Centered><CreateTenant /></Centered>;
  return <Toasts><Books key={tenant.current.id} /></Toasts>;
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="centered"><div className="brand-lg"><img src="/favicon.svg" alt="" width="36" height="36" /> Ledger</div>{children}</div>;
}

function Books() {
  const me = useQuery(api.org.me, {});
  const settings = useQuery(api.org.settings, {});
  const [route] = useRoute();
  const perms = useMemo(() => new Set(me?.permissions ?? []), [me]);
  if (me === undefined || settings === undefined) return <Loading />;
  if (settings === null) {
    return (
      <PermissionsContext.Provider value={perms}>
        <div className="centered"><Setup canSetUp={perms.has("org.manage")} /></div>
      </PermissionsContext.Provider>
    );
  }
  const [section, ...rest] = route;
  const page: Record<string, ReactNode> = {
    overview: <Overview />, banking: <Banking path={rest} />, transactions: <Transactions path={rest} />, invoices: <Invoices path={rest} />,
    bills: <Bills path={rest} />, expenses: <Expenses path={rest} />, accounting: <Accounting path={rest} />, reports: <Reports path={rest} />,
    activity: <Activity />, settings: <Settings />,
  };
  return (
    <PermissionsContext.Provider value={perms}>
      <CurrencyContext.Provider value={settings.baseCurrency}>
        <div className="shell">
          <aside className="nav">
            <div className="brand"><img src="/favicon.svg" alt="" width="26" height="26" /><span>Ledger</span></div>
            <div className="org"><TenantSwitcher /></div>
            <nav aria-label="Main">
              {NAV.map(([id, label, d]) => (
                <a key={id} href={`#/${id}`} className={section === id ? "on" : ""} aria-current={section === id ? "page" : undefined}><Icon d={d} /><span>{label}</span></a>
              ))}
            </nav>
            <div className="who">{me.id} · <span className="role">{me.tenant?.role}</span></div>
          </aside>
          <main>
            <AuthNotices />
            {page[section ?? "overview"] ?? <Overview />}
          </main>
        </div>
      </CurrencyContext.Provider>
    </PermissionsContext.Provider>
  );
}

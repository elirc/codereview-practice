import { Navigate, NavLink, Outlet, Route, Routes } from "react-router-dom";

import type { Role } from "./api/schemas";
import { useAuth } from "./auth/AuthProvider";
import { ApprovalsPage } from "./pages/ApprovalsPage";
import { FinanceQueuePage } from "./pages/FinanceQueuePage";
import { LoginPage } from "./pages/LoginPage";
import { MyReportsPage } from "./pages/MyReportsPage";
import { RatesPage } from "./pages/RatesPage";
import { ReportDetailPage } from "./pages/ReportDetailPage";
import { ReportEditorPage } from "./pages/ReportEditorPage";
import { UsersPage } from "./pages/UsersPage";

type NavItem = { to: string; label: string; roles?: Role[] };

const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "My reports" },
  { to: "/approvals", label: "Approvals", roles: ["manager", "finance", "admin"] },
  { to: "/finance", label: "Finance queue", roles: ["finance"] },
  { to: "/rates", label: "Exchange rates", roles: ["finance", "admin"] },
  { to: "/users", label: "Users", roles: ["admin"] },
];

function Layout() {
  const { me, loading, logout } = useAuth();
  if (loading) {
    return <p>Loading…</p>;
  }
  if (!me) {
    return <Navigate to="/login" replace />;
  }
  const items = NAV_ITEMS.filter((item) => !item.roles || item.roles.includes(me.user.role));
  return (
    <>
      <header>
        <nav>
          {items.map((item) => (
            <NavLink key={item.to} to={item.to} end>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <span>
          {me.user.full_name} ({me.user.role})
        </span>
        <button type="button" onClick={() => void logout()}>
          Sign out
        </button>
      </header>
      <Outlet />
    </>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Layout />}>
        <Route path="/" element={<MyReportsPage />} />
        <Route path="/reports/:id" element={<ReportDetailPage />} />
        <Route path="/reports/:id/edit" element={<ReportEditorPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/finance" element={<FinanceQueuePage />} />
        <Route path="/rates" element={<RatesPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

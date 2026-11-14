import { Navigate, NavLink, Outlet, Route, Routes } from "react-router-dom";

import type { Role } from "./api/schemas";
import { useAuth } from "./auth/AuthProvider";
import { LoginPage } from "./pages/LoginPage";
import { MyReportsPage } from "./pages/MyReportsPage";

type NavItem = { to: string; label: string; roles?: Role[] };

const NAV_ITEMS: NavItem[] = [{ to: "/", label: "My reports" }];

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
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

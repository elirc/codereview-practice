import type { ReactElement } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { DocPage } from './pages/DocPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { WorkspacePage } from './pages/WorkspacePage';

function RequireUser({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth();
  if (loading) return <p>Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export function App() {
  const { user, logout } = useAuth();
  return (
    <>
      <header className="topbar">
        <Link to="/">Collab Docs</Link>
        {user ? (
          <span>
            {user.name} <button onClick={() => void logout()}>Sign out</button>
          </span>
        ) : (
          <span>
            <Link to="/login">Sign in</Link> · <Link to="/register">Register</Link>
          </span>
        )}
      </header>
      <main>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route
            path="/"
            element={
              <RequireUser>
                <HomePage />
              </RequireUser>
            }
          />
          <Route
            path="/w/:workspaceId"
            element={
              <RequireUser>
                <WorkspacePage />
              </RequireUser>
            }
          />
          <Route path="/d/:docId" element={<DocPage />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </>
  );
}

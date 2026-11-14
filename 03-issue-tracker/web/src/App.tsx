import { Navigate, Route, Routes } from 'react-router-dom';
import { useMe } from './auth/session';
import { Layout } from './components/Layout';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { IssueListPage } from './pages/IssueListPage';
import { HomeRedirect, NewOrgPage } from './pages/OrgPages';

export function App() {
  const me = useMe();

  if (me.isPending) return <p>Loading…</p>;
  if (me.error) return <p className="error">Could not reach the server.</p>;

  if (!me.data) {
    return (
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<Layout me={me.data} />}>
        <Route index element={<HomeRedirect me={me.data} />} />
        <Route path="/orgs/new" element={<NewOrgPage />} />
        <Route path="/o/:orgSlug/issues" element={<IssueListPage />} />
      </Route>
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="*" element={<p className="error">Page not found.</p>} />
    </Routes>
  );
}

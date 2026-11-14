import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import type { Me } from '../api/types';
import { useLogout } from '../auth/session';

export function Layout({ me }: { me: Me }) {
  const { orgSlug } = useParams();
  const navigate = useNavigate();
  const logout = useLogout();
  const membership = me.memberships.find((m) => m.orgSlug === orgSlug);

  return (
    <div className="app">
      <header className="topbar">
        <strong>Issue Tracker</strong>
        <label>
          Organisation{' '}
          <select
            value={orgSlug ?? ''}
            onChange={(e) => {
              const next = e.target.value;
              navigate(next ? `/o/${next}/issues` : '/orgs/new');
            }}
          >
            {!membership && <option value="">Choose…</option>}
            {me.memberships.map((m) => (
              <option key={m.orgSlug} value={m.orgSlug}>
                {m.orgName}
              </option>
            ))}
            <option value="">+ New organisation</option>
          </select>
        </label>
        {membership && (
          <nav>
            <NavLink to={`/o/${membership.orgSlug}/issues`}>Issues</NavLink>
            <NavLink to={`/o/${membership.orgSlug}/projects`}>Projects</NavLink>
            <NavLink to={`/o/${membership.orgSlug}/labels`}>Labels</NavLink>
            <NavLink to={`/o/${membership.orgSlug}/members`}>Members</NavLink>
          </nav>
        )}
        <span className="spacer" />
        <span>{me.user.name}</span>
        <button
          type="button"
          onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login') })}
        >
          Sign out
        </button>
      </header>
      <main>
        {orgSlug && !membership ? <p className="error">Organisation not found.</p> : <Outlet />}
      </main>
    </div>
  );
}

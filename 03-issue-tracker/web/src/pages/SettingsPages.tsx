import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { endpoints } from '../api/endpoints';
import { queryKeys } from '../api/keys';
import { ROLES, type Label, type Project, type Role } from '../api/types';
import { useMe } from '../auth/session';
import { atLeast, useLabels, useProjects, useRole } from '../org/queries';

/** A mutation that refreshes the given queries once it settles. */
function useRefreshingMutation<TVars, TData>(
  mutationFn: (vars: TVars) => Promise<TData>,
  keys: QueryKey[],
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () =>
      Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  });
}

export function ProjectsPage() {
  const { orgSlug = '' } = useParams();
  const canManage = atLeast(useRole(orgSlug), 'admin');
  const projects = useProjects(orgSlug);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const create = useRefreshingMutation(
    (input: { key: string; name: string }) => endpoints.createProject(orgSlug, input),
    [queryKeys.projects(orgSlug)],
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      { key, name },
      {
        onSuccess: () => {
          setKey('');
          setName('');
        },
      },
    );
  };

  return (
    <section>
      <h1>Projects</h1>
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Name</th>
            <th>Status</th>
            {canManage && <th />}
          </tr>
        </thead>
        <tbody>
          {projects.data?.map((project) => (
            <ProjectRow
              key={project.id}
              orgSlug={orgSlug}
              project={project}
              canManage={canManage}
            />
          ))}
        </tbody>
      </table>
      {canManage && (
        <form className="inline" onSubmit={submit}>
          <input
            aria-label="Key"
            placeholder="KEY"
            pattern="[A-Z]{2,6}"
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            required
          />
          <input
            aria-label="Name"
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <button type="submit">Create project</button>
          {create.error && <span className="error">{create.error.message}</span>}
        </form>
      )}
    </section>
  );
}

function ProjectRow(props: { orgSlug: string; project: Project; canManage: boolean }) {
  const { orgSlug, project, canManage } = props;
  const [name, setName] = useState(project.name);
  const keys = [queryKeys.projects(orgSlug)];
  const rename = useRefreshingMutation(
    (next: string) => endpoints.renameProject(orgSlug, project.key, next),
    keys,
  );
  const archive = useRefreshingMutation(
    () => endpoints.archiveProject(orgSlug, project.key),
    keys,
  );

  return (
    <tr>
      <td>{project.key}</td>
      <td>
        {canManage ? (
          <input
            aria-label={`${project.key} name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        ) : (
          project.name
        )}
      </td>
      <td>{project.archivedAt ? 'Archived' : 'Active'}</td>
      {canManage && (
        <td>
          {name !== project.name && (
            <button type="button" onClick={() => rename.mutate(name)}>
              Rename
            </button>
          )}
          {!project.archivedAt && (
            <button type="button" onClick={() => archive.mutate(undefined)}>
              Archive
            </button>
          )}
          {(rename.error ?? archive.error) && (
            <span className="error">{(rename.error ?? archive.error)?.message}</span>
          )}
        </td>
      )}
    </tr>
  );
}

export function LabelsPage() {
  const { orgSlug = '' } = useParams();
  const canManage = atLeast(useRole(orgSlug), 'admin');
  const labels = useLabels(orgSlug);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#3366cc');
  const create = useRefreshingMutation(
    (input: { name: string; color: string }) => endpoints.createLabel(orgSlug, input),
    [queryKeys.labels(orgSlug)],
  );

  return (
    <section>
      <h1>Labels</h1>
      <ul>
        {labels.data?.map((label) => (
          <LabelRow key={label.id} orgSlug={orgSlug} label={label} canManage={canManage} />
        ))}
      </ul>
      {canManage && (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ name, color }, { onSuccess: () => setName('') });
          }}
        >
          <input
            aria-label="Label name"
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            aria-label="Colour"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
          <button type="submit">Add label</button>
          {create.error && <span className="error">{create.error.message}</span>}
        </form>
      )}
    </section>
  );
}

function LabelRow(props: { orgSlug: string; label: Label; canManage: boolean }) {
  const { orgSlug, label, canManage } = props;
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);
  // Issues show label names, so their caches refresh as well.
  const keys = [queryKeys.labels(orgSlug), ['org', orgSlug, 'issues']];
  const update = useRefreshingMutation(
    () => endpoints.updateLabel(orgSlug, label.id, { name, color }),
    keys,
  );
  const remove = useRefreshingMutation(() => endpoints.deleteLabel(orgSlug, label.id), keys);

  if (!canManage) {
    return (
      <li>
        <span className="label-chip" style={{ background: label.color }}>
          {label.name}
        </span>
      </li>
    );
  }
  const changed = name !== label.name || color !== label.color;
  return (
    <li className="inline">
      <input aria-label="Label name" value={name} onChange={(e) => setName(e.target.value)} />
      <input
            aria-label="Colour"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
      {changed && (
        <button type="button" onClick={() => update.mutate(undefined)}>
          Save
        </button>
      )}
      <button type="button" onClick={() => remove.mutate(undefined)}>
        Delete
      </button>
      {(update.error ?? remove.error) && (
        <span className="error">{(update.error ?? remove.error)?.message}</span>
      )}
    </li>
  );
}

export function MembersPage() {
  const { orgSlug = '' } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const role = useRole(orgSlug);
  const canManage = atLeast(role, 'admin');
  const queryClient = useQueryClient();
  const membersKey = queryKeys.members(orgSlug);
  const members = useInfiniteQuery({
    queryKey: [...membersKey, 'list'],
    queryFn: ({ pageParam }) => endpoints.listMembers(orgSlug, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<Role>('member');
  const refresh = [membersKey, ['org', orgSlug, 'issues']];
  const add = useRefreshingMutation(
    (input: { email: string; role: Role }) => endpoints.addMember(orgSlug, input),
    refresh,
  );
  const change = useRefreshingMutation(
    (input: { userId: string; role: Role }) =>
      endpoints.changeRole(orgSlug, input.userId, input.role),
    refresh,
  );
  const remove = useRefreshingMutation(
    (userId: string) => endpoints.removeMember(orgSlug, userId),
    refresh,
  );
  const leave = useMutation({
    mutationFn: () => endpoints.removeMember(orgSlug, 'me'),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: queryKeys.org(orgSlug) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      navigate('/');
    },
  });
  // Admins may not grant ownership or touch owners; the server enforces the same rule.
  const grantable = ROLES.filter((r) => r !== 'owner' || role === 'owner');
  const error = add.error ?? change.error ?? remove.error ?? leave.error;

  return (
    <section>
      <h1>Members</h1>
      {error && <p className="error">{error.message}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {members.data?.pages.flatMap((page) =>
            page.items.map((member) => {
              const self = member.userId === me.data?.user.id;
              const editable =
                canManage && !self && (member.role !== 'owner' || role === 'owner');
              return (
                <tr key={member.userId}>
                  <td>{member.name}</td>
                  <td>{member.email}</td>
                  <td>
                    {editable ? (
                      <select
                        aria-label={`Role of ${member.name}`}
                        value={member.role}
                        onChange={(e) =>
                          change.mutate({ userId: member.userId, role: e.target.value as Role })
                        }
                      >
                        {grantable.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      member.role
                    )}
                  </td>
                  <td>
                    {self ? (
                      <button type="button" onClick={() => leave.mutate()}>
                        Leave
                      </button>
                    ) : (
                      editable && (
                        <button type="button" onClick={() => remove.mutate(member.userId)}>
                          Remove
                        </button>
                      )
                    )}
                  </td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
      {members.hasNextPage && (
        <button type="button" onClick={() => members.fetchNextPage()}>
          Load more
        </button>
      )}
      {canManage && (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate({ email, role: newRole }, { onSuccess: () => setEmail('') });
          }}
        >
          <input
            aria-label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <select
            aria-label="Role"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as Role)}
          >
            {grantable.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button type="submit">Add member</button>
        </form>
      )}
    </section>
  );
}

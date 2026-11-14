import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { endpoints } from '../api/endpoints';
import { queryKeys } from '../api/keys';
import {
  PRIORITY_LABELS,
  STATUSES,
  type IssueFilters,
  type IssueSort,
  type IssueStatus,
} from '../api/types';
import { BulkStatusBar } from '../issues/BulkStatusBar';
import { atLeast, useLabels, useMemberOptions, useProjects, useRole } from '../org/queries';

function filtersFrom(params: URLSearchParams): IssueFilters {
  const filters: IssueFilters = {};
  const projectKey = params.get('projectKey');
  const status = params.getAll('status') as IssueStatus[];
  const assigneeId = params.get('assigneeId');
  const labelId = params.getAll('labelId');
  const q = params.get('q');
  const sort = params.get('sort') as IssueSort | null;
  if (projectKey) filters.projectKey = projectKey;
  if (status.length) filters.status = status;
  if (assigneeId) filters.assigneeId = assigneeId;
  if (labelId.length) filters.labelId = labelId;
  if (q) filters.q = q;
  if (sort) filters.sort = sort;
  return filters;
}

export function IssueListPage() {
  const { orgSlug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFrom(params), [params]);
  const [search, setSearch] = useState(filters.q ?? '');
  const projects = useProjects(orgSlug);
  const labels = useLabels(orgSlug);
  const members = useMemberOptions(orgSlug);
  const canEdit = atLeast(useRole(orgSlug), 'member');
  const [selection, setSelection] = useState<Set<string>>(new Set());

  const toggle = (issueId: string, checked: boolean) => {
    setSelection((current) => {
      const next = new Set(current);
      if (checked) next.add(issueId);
      else next.delete(issueId);
      return next;
    });
  };

  const issues = useInfiniteQuery({
    queryKey: queryKeys.issueList(orgSlug, filters),
    queryFn: ({ pageParam }) => endpoints.listIssues(orgSlug, filters, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const update = (name: string, values: string[]) => {
    const next = new URLSearchParams(params);
    next.delete(name);
    for (const value of values) if (value) next.append(name, value);
    setParams(next);
  };

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    update('q', [search.trim()]);
  };

  const selected = (e: ChangeEvent<HTMLSelectElement>) =>
    Array.from(e.target.selectedOptions, (option) => option.value);

  return (
    <section>
      <h1>Issues</h1>
      <NewIssueForm orgSlug={orgSlug} />
      <form className="filters" onSubmit={submitSearch}>
        <input
          type="search"
          placeholder="Search or ENG-42"
          maxLength={200}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="submit">Search</button>
        <select
          aria-label="Project"
          value={filters.projectKey ?? ''}
          onChange={(e) => update('projectKey', [e.target.value])}
        >
          <option value="">All projects</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.key}>
              {p.key}
            </option>
          ))}
        </select>
        <select
          aria-label="Status"
          multiple
          value={filters.status ?? []}
          onChange={(e) => update('status', selected(e))}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          aria-label="Assignee"
          value={filters.assigneeId ?? ''}
          onChange={(e) => update('assigneeId', [e.target.value])}
        >
          <option value="">Anyone</option>
          <option value="none">Unassigned</option>
          {members.data?.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Labels"
          multiple
          value={filters.labelId ?? []}
          onChange={(e) => update('labelId', selected(e))}
        >
          {labels.data?.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Sort"
          value={filters.sort ?? 'created'}
          onChange={(e) => update('sort', [e.target.value])}
        >
          <option value="created">Newest</option>
          <option value="updated">Recently updated</option>
          <option value="priority">Priority</option>
        </select>
      </form>

      {issues.error && <p className="error">{issues.error.message}</p>}
      {canEdit && (
        <BulkStatusBar
          orgSlug={orgSlug}
          filters={filters}
          issueIds={[...selection]}
          onDone={() => setSelection(new Set())}
        />
      )}
      <table>
        <thead>
          <tr>
            {canEdit && <th />}
            <th>ID</th>
            <th>Title</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Assignee</th>
            <th>Labels</th>
          </tr>
        </thead>
        <tbody>
          {issues.data?.pages.flatMap((page) =>
            page.items.map((issue) => (
              <tr key={issue.id}>
                {canEdit && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${issue.identifier}`}
                      checked={selection.has(issue.id)}
                      onChange={(e) => toggle(issue.id, e.target.checked)}
                    />
                  </td>
                )}
                <td>
                  <Link to={`/o/${orgSlug}/issues/${issue.projectKey}/${issue.number}`}>
                    {issue.identifier}
                  </Link>
                </td>
                <td>{issue.title}</td>
                <td>{issue.status}</td>
                <td>{PRIORITY_LABELS[issue.priority]}</td>
                <td>{issue.assignee?.name ?? '—'}</td>
                <td>{issue.labels.map((l) => l.name).join(', ')}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
      {issues.data && issues.data.pages[0].items.length === 0 && <p>No issues match.</p>}
      {issues.hasNextPage && (
        <button
          type="button"
          onClick={() => issues.fetchNextPage()}
          disabled={issues.isFetchingNextPage}
        >
          Load more
        </button>
      )}
    </section>
  );
}

function NewIssueForm({ orgSlug }: { orgSlug: string }) {
  const queryClient = useQueryClient();
  const role = useRole(orgSlug);
  const projects = useProjects(orgSlug);
  const open = projects.data?.filter((p) => !p.archivedAt) ?? [];
  const [projectKey, setProjectKey] = useState('');
  const [title, setTitle] = useState('');
  const create = useMutation({
    mutationFn: (input: { projectKey: string; title: string }) =>
      endpoints.createIssue(orgSlug, input.projectKey, { title: input.title }),
    onSuccess: () => {
      setTitle('');
      return queryClient.invalidateQueries({ queryKey: queryKeys.issueLists(orgSlug) });
    },
  });

  if (!atLeast(role, 'member') || open.length === 0) return null;
  const key = projectKey || open[0].key;

  return (
    <form
      className="inline"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate({ projectKey: key, title });
      }}
    >
      <select
        aria-label="New issue project"
        value={key}
        onChange={(e) => setProjectKey(e.target.value)}
      >
        {open.map((p) => (
          <option key={p.id} value={p.key}>
            {p.key}
          </option>
        ))}
      </select>
      <input
        placeholder="New issue title"
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
      />
      <button type="submit" disabled={create.isPending}>
        Create issue
      </button>
      {create.error && <span className="error">{create.error.message}</span>}
    </form>
  );
}

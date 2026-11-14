import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { endpoints } from '../api/endpoints';
import { queryKeys } from '../api/keys';
import type { Me } from '../api/types';

export function HomeRedirect({ me }: { me: Me }) {
  const first = me.memberships[0];
  return <Navigate to={first ? `/o/${first.orgSlug}/issues` : '/orgs/new'} replace />;
}

export function NewOrgPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: endpoints.createOrg,
    onSuccess: async (org) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
      navigate(`/o/${org.slug}/issues`);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ slug, name });
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>New organisation</h1>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        Slug (lower-case letters, digits and dashes)
        <input
          value={slug}
          pattern="[a-z0-9][a-z0-9\-]{1,38}"
          onChange={(e) => setSlug(e.target.value)}
          required
        />
      </label>
      {create.error && <p className="error">{create.error.message}</p>}
      <button type="submit" disabled={create.isPending}>
        Create
      </button>
    </form>
  );
}

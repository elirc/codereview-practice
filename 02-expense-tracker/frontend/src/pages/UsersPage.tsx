import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { apiGet, apiSend, query } from "../api/client";
import { useMoney } from "../api/currencies";
import { paginated, roleSchema, userSchema, type Role, type User } from "../api/schemas";
import { useMe } from "../auth/AuthProvider";
import { ErrorMessage } from "../components/ErrorMessage";
import { formatMinor, parseMinor } from "../lib/money";

type UserChanges = {
  role: Role;
  manager_id: string | null;
  approval_limit_minor: number;
  active: boolean;
};

function UserRow({ user, everyone }: { user: User; everyone: User[] }) {
  const queryClient = useQueryClient();
  const me = useMe();
  const money = useMoney();
  const exponent = money.exponentOf(me.base_currency) ?? 2;
  const [role, setRole] = useState<Role>(user.role);
  const [managerId, setManagerId] = useState(user.manager_id ?? "");
  const [limit, setLimit] = useState(formatMinor(user.approval_limit_minor, exponent));
  const [active, setActive] = useState(user.active);
  const [problem, setProblem] = useState<string | null>(null);
  const managers = everyone.filter((other) => other.id !== user.id);
  const save = useMutation({
    mutationFn: (changes: UserChanges) =>
      apiSend("PATCH", `/users/${user.id}`, userSchema, changes),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["users"] }),
  });

  const submit = () => {
    const parsed = parseMinor(limit, exponent);
    if (!parsed.ok) {
      setProblem(parsed.error);
      return;
    }
    setProblem(null);
    save.mutate({
      role,
      manager_id: managerId || null,
      approval_limit_minor: parsed.minor,
      active,
    });
  };

  return (
    <tr>
      <td>{user.full_name}</td>
      <td>{user.email}</td>
      <td>
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {roleSchema.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </td>
      <td>
        <select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
          <option value="">No manager</option>
          {managers.map((other) => (
            <option key={other.id} value={other.id}>
              {other.full_name}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input value={limit} inputMode="decimal" onChange={(e) => setLimit(e.target.value)} />
      </td>
      <td>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
      </td>
      <td>
        <button type="button" disabled={save.isPending} onClick={submit}>
          Save
        </button>
        {problem && <p className="error">{problem}</p>}
        <ErrorMessage error={save.error} />
      </td>
    </tr>
  );
}

export function UsersPage() {
  const me = useMe();
  const users = useQuery({
    queryKey: ["users"],
    queryFn: () => apiGet(`/users${query({ limit: 200 })}`, paginated(userSchema)),
  });
  const everyone = users.data?.items ?? [];

  return (
    <main>
      <h1>Users</h1>
      <ErrorMessage error={users.error} />
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
            <th>Manager</th>
            <th>Approval limit ({me.base_currency})</th>
            <th>Active</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {everyone.map((user) => (
            <UserRow key={user.id} user={user} everyone={everyone} />
          ))}
        </tbody>
      </table>
    </main>
  );
}

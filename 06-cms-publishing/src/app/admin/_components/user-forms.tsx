"use client";

import { useState, type FormEvent } from "react";
import { createUser, updateUser } from "@/actions/users";
import type { Role } from "@/db/schema";
import { ErrorMessage } from "./error-message";
import { useActionRunner } from "./use-action";

const ROLES: Role[] = ["author", "editor", "admin"];

export function CreateUserForm() {
  const { run, error, pending } = useActionRunner();
  const [form, setForm] = useState({ email: "", name: "", role: "author" as Role, password: "" });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    run(
      () => createUser(form),
      () => setForm({ email: "", name: "", role: "author", password: "" }),
    );
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <label>
        Email
        <input
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          required
        />
      </label>
      <label>
        Name
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
      </label>
      <label>
        Role
        <select
          value={form.role}
          onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
        >
          {ROLES.map((role) => (
            <option key={role}>{role}</option>
          ))}
        </select>
      </label>
      <label>
        Initial password
        <input
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          required
        />
      </label>
      <ErrorMessage error={error} />
      <button type="submit" disabled={pending}>
        Create user
      </button>
    </form>
  );
}

type UserRowProps = { user: { id: string; name: string; role: Role; active: boolean } };

export function UserRowForm({ user }: UserRowProps) {
  const { run, error, pending } = useActionRunner();
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<Role>(user.role);
  const [active, setActive] = useState(user.active);
  const [password, setPassword] = useState("");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const changes = {
      ...(name !== user.name && { name }),
      ...(role !== user.role && { role }),
      ...(active !== user.active && { active }),
      ...(password !== "" && { password }),
    };
    run(
      () => updateUser({ userId: user.id, ...changes }),
      () => setPassword(""),
    );
  }

  return (
    <form className="inline" onSubmit={onSubmit}>
      <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
      <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
        {ROLES.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
      <label>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Active
      </label>
      <input
        type="password"
        placeholder="New password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-label="New password"
      />
      <button type="submit" disabled={pending}>
        Save
      </button>
      <ErrorMessage error={error} />
    </form>
  );
}

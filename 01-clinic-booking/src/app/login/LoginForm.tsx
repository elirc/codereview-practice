"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiRequest, describeError } from "../_components/api";

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    const result = await apiRequest("/api/auth/login", {
      body: { email: form.get("email"), password: form.get("password") },
    });
    setPending(false);
    if (!result.ok) {
      setError(describeError(result.error));
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="stack">
      <label>
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      <button type="submit" disabled={pending}>
        Sign in
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

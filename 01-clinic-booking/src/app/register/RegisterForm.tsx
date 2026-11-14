"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { apiRequest, describeError } from "../_components/api";

export function RegisterForm() {
  const router = useRouter();
  const [timezone, setTimezone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The browser's zone is only known on the client, so it is filled in after hydration.
  useEffect(() => {
    setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const phone = String(form.get("phone") ?? "").trim();
    setPending(true);
    const result = await apiRequest("/api/auth/register", {
      body: {
        email: form.get("email"),
        password: form.get("password"),
        fullName: form.get("fullName"),
        timezone,
        ...(phone ? { phone } : {}),
      },
    });
    setPending(false);
    if (!result.ok) {
      setError(describeError(result.error));
      return;
    }
    router.push("/book");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="stack">
      <label>
        <span>Full name</span>
        <input name="fullName" required />
      </label>
      <label>
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        <span>Password (at least 10 characters)</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={10}
          required
        />
      </label>
      <label>
        <span>Phone (optional)</span>
        <input name="phone" type="tel" />
      </label>
      <label>
        <span>Time zone</span>
        <input value={timezone} onChange={(event) => setTimezone(event.target.value)} required />
      </label>
      <button type="submit" disabled={pending}>
        Create account
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

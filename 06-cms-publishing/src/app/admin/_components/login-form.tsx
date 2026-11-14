"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { login } from "@/actions/auth";
import { ErrorMessage } from "./error-message";
import { useActionRunner } from "./use-action";

export function LoginForm() {
  const router = useRouter();
  const { run, error, pending } = useActionRunner();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    run(() => login({ email, password }), (data) => router.replace(data.redirectTo));
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <label>
        Email
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>
      <label>
        Password
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      <ErrorMessage error={error} />
      <button type="submit" disabled={pending}>
        Sign in
      </button>
    </form>
  );
}

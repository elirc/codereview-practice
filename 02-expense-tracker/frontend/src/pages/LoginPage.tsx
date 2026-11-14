import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { z } from "zod";

import { useAuth } from "../auth/AuthProvider";
import { ErrorMessage } from "../components/ErrorMessage";

const loginForm = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

export function LoginPage() {
  const { me, login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (me) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = loginForm.safeParse({ email, password });
    if (!parsed.success) {
      setError(new Error(parsed.error.issues.map((issue) => issue.message).join(" ")));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(parsed.data.email, parsed.data.password);
      navigate("/");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="narrow">
      <h1>Sign in</h1>
      <form onSubmit={onSubmit}>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <ErrorMessage error={error} />
        <button type="submit" disabled={busy}>
          Sign in
        </button>
      </form>
    </main>
  );
}

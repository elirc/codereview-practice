import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLogin, useRegister } from '../auth/session';

export function LoginPage() {
  const login = useLogin();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password }, { onSuccess: () => navigate('/') });
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>Sign in</h1>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {login.error && <p className="error">{login.error.message}</p>}
      <button type="submit" disabled={login.isPending}>
        Sign in
      </button>
      <p>
        No account? <Link to="/register">Register</Link>
      </p>
    </form>
  );
}

export function RegisterPage() {
  const register = useRegister();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', name: '', password: '' });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    register.mutate(form, { onSuccess: () => navigate('/orgs/new') });
  };

  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>Create an account</h1>
      <label>
        Name
        <input
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          required
        />
      </label>
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
        Password (at least 8 characters)
        <input
          type="password"
          minLength={8}
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          required
        />
      </label>
      {register.error && <p className="error">{register.error.message}</p>}
      <button type="submit" disabled={register.isPending}>
        Register
      </button>
      <p>
        Already registered? <Link to="/login">Sign in</Link>
      </p>
    </form>
  );
}

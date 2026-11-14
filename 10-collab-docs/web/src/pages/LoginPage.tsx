import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { errorMessage, useAuth } from '../auth';

export function LoginPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api('POST', '/auth/login', { email, password });
      await refresh();
      navigate('/');
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Sign in</h1>
      {error && <p className="error">{error}</p>}
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
      <button type="submit">Sign in</button>
      <p>
        No account? <Link to="/register">Register</Link>
      </p>
    </form>
  );
}

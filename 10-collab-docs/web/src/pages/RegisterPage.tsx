import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { errorMessage, useAuth } from '../auth';

export function RegisterPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await api('POST', '/auth/register', form);
      await refresh();
      navigate('/');
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }

  const field = (key: keyof typeof form) => ({
    value: form[key],
    onChange: (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value }),
  });

  return (
    <form className="card" onSubmit={submit}>
      <h1>Create an account</h1>
      {error && <p className="error">{error}</p>}
      <label>
        Name
        <input {...field('name')} required maxLength={100} />
      </label>
      <label>
        Email
        <input type="email" {...field('email')} required />
      </label>
      <label>
        Password (at least 8 characters)
        <input type="password" {...field('password')} required minLength={8} />
      </label>
      <button type="submit">Register</button>
    </form>
  );
}

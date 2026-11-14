import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, type User, type Workspace } from './api';

interface AuthState {
  user: User | null;
  workspaces: Workspace[];
  loading: boolean;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: User; workspaces: Workspace[] }>('GET', '/auth/me');
      setUser(me.user);
      setWorkspaces(me.workspaces);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      setUser(null);
      setWorkspaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api('POST', '/auth/logout');
    setUser(null);
    setWorkspaces([]);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ user, workspaces, loading, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

/** Returns a readable message for an error thrown by the API helpers. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}

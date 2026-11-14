import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";

import { ApiError, apiGet, apiSend, apiSendNoContent } from "../api/client";
import { meSchema, type Me } from "../api/schemas";

type AuthState = {
  me: Me | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

async function fetchMe(): Promise<Me | null> {
  try {
    return await apiGet("/auth/me", meSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const meQuery = useQuery({ queryKey: ["me"], queryFn: fetchMe, staleTime: 60_000 });

  const login = async (email: string, password: string) => {
    const me = await apiSend("POST", "/auth/login", meSchema, { email, password });
    queryClient.clear();
    queryClient.setQueryData(["me"], me);
  };

  const logout = async () => {
    await apiSendNoContent("POST", "/auth/logout");
    queryClient.clear();
    queryClient.setQueryData(["me"], null);
  };

  const value: AuthState = {
    me: meQuery.data ?? null,
    loading: meQuery.isPending,
    login,
    logout,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return state;
}

/** The signed-in user; only call below a route that requires authentication. */
export function useMe(): Me {
  const { me } = useAuth();
  if (!me) {
    throw new Error("useMe requires a signed-in user");
  }
  return me;
}

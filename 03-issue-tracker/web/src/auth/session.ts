import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { endpoints } from '../api/endpoints';
import { queryKeys } from '../api/keys';
import type { Me } from '../api/types';

/** The signed-in user, or null when there is no valid session. */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async (): Promise<Me | null> => {
      try {
        return await endpoints.me();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: endpoints.login,
    onSuccess: (me) => {
      queryClient.removeQueries();
      queryClient.setQueryData(queryKeys.me, me);
    },
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: endpoints.register,
    onSuccess: (me) => {
      queryClient.removeQueries();
      queryClient.setQueryData(queryKeys.me, me);
    },
  });
}

/** Signing out drops every cached query so the next user starts from nothing. */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => endpoints.logout(),
    onSettled: () => {
      queryClient.removeQueries();
      queryClient.setQueryData(queryKeys.me, null);
    },
  });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DigitalToken, TokenStatus } from '@transitlink/shared';
import { getDataSource, MOCK_STUDENT_ID } from './dataSource';

export const keys = {
  snapshot: ['snapshot'] as const,
  tokens: ['tokens'] as const,
};

export function useSnapshot() {
  return useQuery({ queryKey: keys.snapshot, queryFn: () => getDataSource().getSnapshot(), staleTime: Infinity });
}

/** Kept fresh by `token:update` socket events (RealtimeBridge). */
export function useTokens() {
  return useQuery({ queryKey: keys.tokens, queryFn: () => getDataSource().getTokens(), staleTime: Infinity });
}

export function upsertToken(list: DigitalToken[] | undefined, t: DigitalToken): DigitalToken[] {
  return [...(list ?? []).filter((x) => x.id !== t.id), t];
}

export function useJoinQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tripId: string) => getDataSource().joinQueue(MOCK_STUDENT_ID, tripId),
    onSuccess: (t) => qc.setQueryData<DigitalToken[]>(keys.tokens, (list) => upsertToken(list, t)),
  });
}

export function useSetTokenStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: TokenStatus }) => getDataSource().updateTokenStatus(id, status),
    onSuccess: (t) => qc.setQueryData<DigitalToken[]>(keys.tokens, (list) => upsertToken(list, t)),
  });
}

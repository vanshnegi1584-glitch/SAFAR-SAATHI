'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { RealtimeBridge } from '@/components/RealtimeBridge';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 2 } } }));
  return (
    <QueryClientProvider client={client}>
      <RealtimeBridge />
      {children}
    </QueryClientProvider>
  );
}

'use client';

import dynamic from 'next/dynamic';
import { RequireStaff } from '@/components/RequireStaff';

const RouteSetup = dynamic(() => import('@/components/RouteSetup'), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-slate-500">Loading map…</div>,
});

export default function RouteSetupPage() {
  return <RequireStaff admin>{() => <RouteSetup />}</RequireStaff>;
}

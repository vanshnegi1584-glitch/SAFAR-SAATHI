'use client';

import dynamic from 'next/dynamic';
import { RequireStaff } from '@/components/RequireStaff';

const GpsFleet = dynamic(() => import('@/components/GpsFleet'), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-sm text-slate-500">Loading map…</div>,
});

export default function TrackingPage() {
  return <RequireStaff>{() => <GpsFleet />}</RequireStaff>;
}

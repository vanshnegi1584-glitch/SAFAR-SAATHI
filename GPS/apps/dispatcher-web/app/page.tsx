'use client';

import dynamic from 'next/dynamic';
import { FleetPanel } from '@/components/FleetPanel';

const loading = () => <div className="grid h-full place-items-center text-sm text-slate-500">Loading map…</div>;

// Google Maps (real road routes) when a key is configured; otherwise the keyless MapLibre map with
// straight-line mock routes, so teammates without a Google billing account can still run the app.
// Both touch `window` at import time, so the map is client-only.
const LiveMap = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY
  ? dynamic(() => import('@/components/GoogleLiveMap'), { ssr: false, loading })
  : dynamic(() => import('@/components/LiveMap'), { ssr: false, loading });

export default function DashboardPage() {
  return (
    <div className="flex h-full">
      <aside className="w-80 shrink-0 overflow-y-auto border-r border-slate-200 bg-white">
        <h2 className="border-b border-slate-100 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Fleet</h2>
        <FleetPanel />
      </aside>
      <section className="relative min-w-0 flex-1">
        <LiveMap />
      </section>
    </div>
  );
}

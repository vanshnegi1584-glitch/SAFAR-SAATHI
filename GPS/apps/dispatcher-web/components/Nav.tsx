'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getDataSource } from '@/lib/dataSource';

const LINKS = [
  { href: '/', label: 'Live Map' },
  { href: '/queue', label: 'Queue Manager' },
  { href: '/tracking', label: 'Live GPS' },
  { href: '/admin/routes', label: 'Route Setup' },
];

export function Nav() {
  const pathname = usePathname();
  const isMock = getDataSource().kind === 'mock';
  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4">
      <div className="flex items-center gap-6">
        <span className="text-lg font-bold tracking-tight">TransitLink <span className="font-normal text-slate-400">Dispatch</span></span>
        <nav className="flex gap-1">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-md px-3 py-1.5 text-sm ${pathname === l.href ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
      {isMock && (
        <div className="flex items-center gap-2">
          <span className="rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800">MOCK DATA</span>
          <button
            onClick={() => getDataSource().raiseSos('B-405')}
            className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
            title="Demo only: simulate the driver pressing SOS on B-405"
          >
            Simulate SOS
          </button>
        </div>
      )}
    </header>
  );
}

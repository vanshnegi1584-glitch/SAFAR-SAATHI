import { OCCUPANCY_COLOR, occupancyLevel } from '@transitlink/shared';

export function CapacityBar({ pax, capacity }: { pax: number; capacity: number }) {
  const pct = capacity > 0 ? Math.min(100, (pax / capacity) * 100) : 0;
  const level = occupancyLevel(pax, capacity);
  return (
    <div className="flex items-center gap-2" title={`${pax} of ${capacity} seats occupied`}>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: OCCUPANCY_COLOR[level] }} />
      </div>
      <span className="w-12 text-right text-xs tabular-nums text-slate-600">{pax}/{capacity}</span>
    </div>
  );
}

import type { DigitalToken, TokenStatus } from './types';

export type OccupancyLevel = 'low' | 'medium' | 'high' | 'full';

export function occupancyLevel(pax: number, capacity: number): OccupancyLevel {
  if (capacity <= 0) return 'full';
  const r = pax / capacity;
  if (r >= 1) return 'full';
  if (r >= 0.85) return 'high';
  if (r >= 0.5) return 'medium';
  return 'low';
}

export const OCCUPANCY_COLOR: Record<OccupancyLevel, string> = {
  low: '#16a34a',
  medium: '#ca8a04',
  high: '#ea580c',
  full: '#dc2626',
};

const ACTIVE: TokenStatus[] = ['waiting', 'called'];

export function isActiveToken(t: DigitalToken): boolean {
  return ACTIVE.includes(t.status);
}

/** Tokens grouped by trip, each list ordered by queue position. */
export function groupTokensByTrip(tokens: DigitalToken[]): Map<string, DigitalToken[]> {
  const out = new Map<string, DigitalToken[]>();
  for (const t of tokens) {
    const list = out.get(t.trip_id) ?? [];
    list.push(t);
    out.set(t.trip_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.queue_position - b.queue_position);
  return out;
}

/** The waiting tokens that fit in the seats still free (seats already promised to 'called' tokens are excluded). */
export function nextToCall(tripTokens: DigitalToken[], availableSeats: number): DigitalToken[] {
  const alreadyCalled = tripTokens.filter((t) => t.status === 'called').length;
  const free = Math.max(0, availableSeats - alreadyCalled);
  return tripTokens
    .filter((t) => t.status === 'waiting')
    .sort((a, b) => a.queue_position - b.queue_position)
    .slice(0, free);
}

/** Position among tokens still waiting (1-based), or null if the token is no longer waiting. */
export function effectivePosition(token: DigitalToken, tripTokens: DigitalToken[]): number | null {
  if (token.status !== 'waiting') return null;
  return tripTokens.filter((t) => t.status === 'waiting' && t.queue_position < token.queue_position).length + 1;
}

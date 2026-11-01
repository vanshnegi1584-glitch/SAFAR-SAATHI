import { io, type Socket } from 'socket.io-client';
import { Emitter } from './emitter';
import type { FleetSnapshot, TransitDataSource } from './source';
import type { DigitalToken, FallbackSuggestion, ServerToClientEvents, TokenStatus } from './types';

export interface LiveSourceOptions {
  apiUrl: string;
  /** Returns the Supabase access token for the signed-in user. */
  getAccessToken?: () => Promise<string | null> | string | null;
}

const EVENTS: (keyof ServerToClientEvents)[] = [
  'telemetry:update', 'telemetry:batch', 'token:update', 'sos:alert', 'sos:cleared',
  'trip:last_bus_departed', 'fallback:suggestion',
];

/**
 * Talks to Siddhant's Node/Express + Socket.io server. Endpoint paths follow docs/CONTRACT.md,
 * which is a proposal — update both together if the backend chooses different routes.
 * Not yet tested against a real server.
 */
export class LiveTransitSource implements TransitDataSource {
  readonly kind = 'live' as const;
  private socket: Socket<ServerToClientEvents> | null = null;
  private readonly events = new Emitter<ServerToClientEvents>();

  constructor(private readonly opts: LiveSourceOptions) {}

  connect(): void {
    if (this.socket) return;
    this.socket = io(this.opts.apiUrl, {
      transports: ['websocket'],
      auth: async (cb) => cb({ token: (await this.opts.getAccessToken?.()) ?? null }),
    });
    for (const e of EVENTS) {
      // Re-emit through our own emitter so subscribers survive reconnects.
      this.socket.on(e as any, (...args: any[]) => (this.events.emit as any)(e, ...args));
    }
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  on<E extends keyof ServerToClientEvents>(event: E, handler: ServerToClientEvents[E]) {
    return this.events.on(event, handler);
  }

  getSnapshot(): Promise<FleetSnapshot> {
    return this.request('/api/fleet/snapshot');
  }

  getTokens(): Promise<DigitalToken[]> {
    return this.request('/api/tokens?active=true');
  }

  updateTokenStatus(tokenId: string, status: TokenStatus): Promise<DigitalToken> {
    return this.request(`/api/tokens/${encodeURIComponent(tokenId)}`, { method: 'PATCH', body: { status } });
  }

  joinQueue(_studentId: string, tripId: string): Promise<DigitalToken> {
    // student id comes from the auth token server-side; never trust it from the client
    return this.request('/api/tokens', { method: 'POST', body: { trip_id: tripId } });
  }

  raiseSos(busId: string): Promise<void> {
    return this.request('/api/sos', { method: 'POST', body: { bus_id: busId } });
  }

  clearSos(busId: string): Promise<void> {
    return this.request(`/api/sos/${encodeURIComponent(busId)}`, { method: 'DELETE' });
  }

  getFallbackSuggestion(): Promise<FallbackSuggestion | null> {
    // Backend runs find_fallback_route with users.home_location; client-sent location is ignored.
    return this.request('/api/students/me/fallback');
  }

  reportGeofenceEvent(e: { bus_id: string; region_id: string; event: 'enter' | 'exit'; timestamp: number }): Promise<void> {
    return this.request('/api/geofence-events', { method: 'POST', body: e });
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await this.opts.getAccessToken?.();
    const res = await fetch(`${this.opts.apiUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed: ${res.status}`);
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }
}

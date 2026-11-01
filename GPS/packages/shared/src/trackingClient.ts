import { io, type Socket } from 'socket.io-client';
import { Emitter } from './emitter';
import type {
  DriverLocationPayload, LocationAck, PublicBus, PublicRoute, TrackingClientEvents, TrackingServerEvents,
  TrackingSnapshot, TripDirection, TripSummary,
} from './trackingTypes';

// Client for the tracking server (apps/tracking-server): authenticated REST + Socket.IO. Used by the
// driver app, student app and dispatcher web. Positions shown in the UI come only from this server.

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'unauthorised';

export interface Me {
  user_id: string;
  role: 'admin' | 'operator' | 'driver' | 'conductor' | 'passenger' | 'student';
  student_route: { route_id: string; stop_id: string | null } | null;
  driver_bus_id: string | null;
}

export interface DriverSlot {
  id: string;
  local_time: string;
  label: string;
  direction: TripDirection;
  status: 'matched' | 'conflict' | 'no_service' | 'unconfirmed' | 'confirmed' | 'cancelled';
  note: string;
}

export interface DriverInfo {
  bus: PublicBus | null;
  route: PublicRoute | null;
  slots: DriverSlot[];
  open_trip: TripSummary | null;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

type ClientEvents = TrackingServerEvents & { 'connection:state': (s: ConnectionState) => void };

export class TrackingClient {
  private socket: Socket<TrackingServerEvents, TrackingClientEvents> | null = null;
  private readonly events = new Emitter<ClientEvents>();
  state: ConnectionState = 'disconnected';

  constructor(private readonly apiUrl: string, private readonly getAccessToken: () => Promise<string | null>) {}

  connect(): void {
    if (this.socket) return;
    this.setState('connecting');
    const s: Socket<TrackingServerEvents, TrackingClientEvents> = io(this.apiUrl, {
      transports: ['websocket'],
      // Called on every (re)connect, so an expired token is refreshed before reconnecting.
      auth: (cb) => void this.getAccessToken().then((token) => cb({ token })),
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
    });
    s.on('connect', () => this.setState('connected'));
    s.on('disconnect', () => this.setState('disconnected'));
    s.on('connect_error', (e) => this.setState(e.message === 'unauthenticated' ? 'unauthorised' : 'disconnected'));
    const names: (keyof TrackingServerEvents)[] = [
      'trip:started', 'trip:updated', 'trip:ended', 'bus:location', 'bus:stale', 'bus:offline', 'bus:arrived',
      'route:deviation', 'bus:seats', 'tracking:error',
    ];
    for (const n of names) s.on(n as never, ((p: never) => (this.events.emit as (e: string, p: unknown) => void)(n, p)) as never);
    this.socket = s;
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.setState('disconnected');
  }

  private setState(s: ConnectionState) {
    this.state = s;
    this.events.emit('connection:state', s);
  }

  on<E extends keyof ClientEvents>(event: E, handler: ClientEvents[E]): () => void {
    return this.events.on(event, handler);
  }

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Sends one fix over the socket; resolves with the server's verdict, or null on timeout/offline. */
  sendLocation(p: DriverLocationPayload, timeoutMs = 5000): Promise<LocationAck | null> {
    const s = this.socket;
    if (!s?.connected) return Promise.resolve(null);
    return new Promise((resolve) => {
      s.timeout(timeoutMs).emit('driver:location', p, (err: Error | null, ack: LocationAck) => resolve(err ? null : ack));
    });
  }

  subscribeRoute(routeId: string): Promise<{ ok: boolean; error?: string }> {
    const s = this.socket;
    if (!s) return Promise.resolve({ ok: false, error: 'not_connected' });
    return new Promise((resolve) => s.emit('track:subscribe', { route_id: routeId }, resolve));
  }

  // ---- REST ------------------------------------------------------------------------------------
  async request<T>(path: string, init: { method?: string; body?: unknown; contentType?: string } = {}): Promise<T> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.apiUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'Content-Type': init.contentType ?? 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
    });
    if (res.status === 204) return undefined as T;
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, json?.error ?? 'http_error', json?.message ?? `${init.method ?? 'GET'} ${path} failed (${res.status})`);
    return json as T;
  }

  me = () => this.request<Me>('/api/me');
  snapshot = () => this.request<TrackingSnapshot>('/api/tracking/snapshot');
  driverInfo = () => this.request<DriverInfo>('/api/driver/me');
  startTrip = (direction: TripDirection, slotId: string | null) =>
    this.request<TripSummary>('/api/driver/trips', { method: 'POST', body: { direction, slot_id: slotId } });
  endTrip = (tripId: string) => this.request<TripSummary>(`/api/driver/trips/${encodeURIComponent(tripId)}/end`, { method: 'POST' });
  postLocations = (fixes: DriverLocationPayload[]) =>
    this.request<{ acks: LocationAck[] }>('/api/driver/locations', { method: 'POST', body: { fixes } });
  setStudentRoute = (routeId: string, stopId: string | null) =>
    this.request<{ route_id: string; stop_id: string | null }>('/api/students/me/route', { method: 'PUT', body: { route_id: routeId, stop_id: stopId } });
}

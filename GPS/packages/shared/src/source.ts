import type {
  ActiveTrip, Bus, DigitalToken, FallbackSuggestion, LngLat, Route, ServerToClientEvents, Stop, TokenStatus,
} from './types';

export interface FleetSnapshot {
  routes: Route[];
  stops: Stop[];
  buses: Bus[];
  trips: ActiveTrip[];
}

/**
 * The single seam between UI and backend. Screens depend only on this interface, so the mock
 * simulator and Siddhant's Socket.io/REST server are interchangeable.
 */
export interface TransitDataSource {
  readonly kind: 'mock' | 'live';
  connect(): void;
  disconnect(): void;
  on<E extends keyof ServerToClientEvents>(event: E, handler: ServerToClientEvents[E]): () => void;

  getSnapshot(): Promise<FleetSnapshot>;
  getTokens(): Promise<DigitalToken[]>;
  updateTokenStatus(tokenId: string, status: TokenStatus): Promise<DigitalToken>;
  joinQueue(studentId: string, tripId: string): Promise<DigitalToken>;
  raiseSos(busId: string): Promise<void>;
  clearSos(busId: string): Promise<void>;
  /** `find_fallback_route` (§2.2). `home` is only used by the mock; the backend reads users.home_location. */
  getFallbackSuggestion(studentId: string, defaultRouteId: string, home: LngLat): Promise<FallbackSuggestion | null>;
  /** Driver geofence transition (enter/exit a stop or campus). */
  reportGeofenceEvent(e: { bus_id: string; region_id: string; event: 'enter' | 'exit'; timestamp: number }): Promise<void>;
}

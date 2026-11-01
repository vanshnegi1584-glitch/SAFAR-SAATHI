import { SafarSaathiClient, createSafarSaathiClient, SupabaseConfig } from '../client.js';
import { BusRepository } from './bus.repository.js';
import { RouteRepository } from './route.repository.js';
import { TripRepository } from './trip.repository.js';
import { BookingRepository } from './booking.repository.js';
import { LocationRepository } from './location.repository.js';

export * from './base.repository.js';
export * from './bus.repository.js';
export * from './route.repository.js';
export * from './trip.repository.js';
export * from './booking.repository.js';
export * from './location.repository.js';

export class SafarSaathiRepository {
  public readonly client: SafarSaathiClient;
  public readonly buses: BusRepository;
  public readonly routes: RouteRepository;
  public readonly trips: TripRepository;
  public readonly bookings: BookingRepository;
  public readonly locations: LocationRepository;

  constructor(clientOrConfig?: SafarSaathiClient | SupabaseConfig) {
    if (clientOrConfig && 'from' in clientOrConfig) {
      this.client = clientOrConfig as SafarSaathiClient;
    } else {
      this.client = createSafarSaathiClient(clientOrConfig);
    }

    this.buses = new BusRepository(this.client);
    this.routes = new RouteRepository(this.client);
    this.trips = new TripRepository(this.client);
    this.bookings = new BookingRepository(this.client);
    this.locations = new LocationRepository(this.client);
  }
}

import { BaseRepository } from './base.repository.js';
import { Database, TripStatus } from '../types/database.types.js';

type TripRow = Database['public']['Tables']['trips']['Row'];
type TripInsert = Database['public']['Tables']['trips']['Insert'];
type TripUpdate = Database['public']['Tables']['trips']['Update'];
type AvailableSeatRow = Database['public']['Views']['view_available_seats']['Row'];

export interface TripSearchParams {
  sourceCity?: string;
  destinationCity?: string;
  travelDate?: string; // YYYY-MM-DD
}

export class TripRepository extends BaseRepository {
  /**
   * Search scheduled trips with bus and route details
   */
  async searchTrips(params: TripSearchParams) {
    let query = this.client
      .from('trips')
      .select(`
        *,
        buses (
          id,
          bus_number,
          bus_name,
          bus_type,
          total_capacity,
          amenities
        ),
        routes (
          id,
          route_code,
          source_city,
          destination_city,
          distance_km,
          estimated_duration_minutes,
          stops
        )
      `)
      .neq('status', 'cancelled')
      .order('departure_time', { ascending: true });

    if (params.travelDate) {
      const startOfDay = `${params.travelDate}T00:00:00.000Z`;
      const endOfDay = `${params.travelDate}T23:59:59.999Z`;
      query = query.gte('departure_time', startOfDay).lte('departure_time', endOfDay);
    }

    const { data, error } = await query;
    if (error) throw error;

    let results = data || [];
    if (params.sourceCity) {
      const src = params.sourceCity.toLowerCase();
      results = results.filter((t: any) => t.routes?.source_city?.toLowerCase().includes(src));
    }
    if (params.destinationCity) {
      const dest = params.destinationCity.toLowerCase();
      results = results.filter((t: any) => t.routes?.destination_city?.toLowerCase().includes(dest));
    }

    return results;
  }

  /**
   * Get trip by ID with bus and route info
   */
  async getTripById(tripId: string) {
    const { data, error } = await this.client
      .from('trips')
      .select(`
        *,
        buses (*),
        routes (*)
      `)
      .eq('id', tripId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data;
  }

  /**
   * Get available seats for a specific trip
   */
  async getAvailableSeats(tripId: string): Promise<AvailableSeatRow[]> {
    const { data, error } = await this.client
      .from('view_available_seats')
      .select('*')
      .eq('trip_id', tripId);

    if (error) throw error;
    return data || [];
  }

  /**
   * Create a new trip schedule
   */
  async createTrip(trip: TripInsert): Promise<TripRow> {
    const { data, error } = await this.client
      .from('trips')
      .insert(trip)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Update trip status (e.g. 'boarding', 'in_transit', 'delayed', 'completed', 'cancelled')
   */
  async updateTripStatus(
    tripId: string,
    status: TripStatus,
    cancellationReason?: string
  ): Promise<TripRow> {
    const updates: TripUpdate = { status };
    if (cancellationReason) {
      updates.cancellation_reason = cancellationReason;
    }

    const { data, error } = await this.client
      .from('trips')
      .update(updates)
      .eq('id', tripId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }
}

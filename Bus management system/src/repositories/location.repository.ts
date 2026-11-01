import { BaseRepository } from './base.repository.js';
import { Database } from '../types/database.types.js';

type LocationRow = Database['public']['Tables']['bus_locations']['Row'];
type LocationInsert = Database['public']['Tables']['bus_locations']['Insert'];

export class LocationRepository extends BaseRepository {
  /**
   * Post new GPS coordinate ping for a bus
   */
  async recordLocation(location: LocationInsert): Promise<LocationRow> {
    const { data, error } = await this.client
      .from('bus_locations')
      .insert(location)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Get the most recent live location of a bus
   */
  async getLatestLocation(busId: string): Promise<LocationRow | null> {
    const { data, error } = await this.client
      .from('bus_locations')
      .select('*')
      .eq('bus_id', busId)
      .order('recorded_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data;
  }

  /**
   * Get location breadcrumb trail for an active trip
   */
  async getTripLocationTrail(tripId: string, limit = 50): Promise<LocationRow[]> {
    const { data, error } = await this.client
      .from('bus_locations')
      .select('*')
      .eq('trip_id', tripId)
      .order('recorded_at', { ascending: true })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }

  /**
   * Listen to real-time GPS updates for a bus via Supabase Realtime
   */
  subscribeToBusLiveLocation(
    busId: string,
    callback: (location: LocationRow) => void
  ) {
    return this.client
      .channel(`bus-tracking-${busId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'bus_locations',
          filter: `bus_id=eq.${busId}`,
        },
        (payload) => {
          callback(payload.new as LocationRow);
        }
      )
      .subscribe();
  }
}

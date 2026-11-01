import { BaseRepository } from './base.repository.js';
import { Database } from '../types/database.types.js';

type BusRow = Database['public']['Tables']['buses']['Row'];
type BusInsert = Database['public']['Tables']['buses']['Insert'];
type BusUpdate = Database['public']['Tables']['buses']['Update'];
type SeatRow = Database['public']['Tables']['seats']['Row'];
type SeatInsert = Database['public']['Tables']['seats']['Insert'];

export class BusRepository extends BaseRepository {
  /**
   * Fetch all active buses
   */
  async getAllActiveBuses(): Promise<BusRow[]> {
    const { data, error } = await this.client
      .from('buses')
      .select('*')
      .eq('is_active', true)
      .order('bus_name', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Get bus by ID
   */
  async getBusById(id: string): Promise<BusRow | null> {
    const { data, error } = await this.client
      .from('buses')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data;
  }

  /**
   * Get seats layout for a specific bus
   */
  async getSeatsByBusId(busId: string): Promise<SeatRow[]> {
    const { data, error } = await this.client
      .from('seats')
      .select('*')
      .eq('bus_id', busId)
      .order('seat_number', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Create a new bus
   */
  async createBus(bus: BusInsert): Promise<BusRow> {
    const { data, error } = await this.client
      .from('buses')
      .insert(bus)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Update bus details
   */
  async updateBus(id: string, updates: BusUpdate): Promise<BusRow> {
    const { data, error } = await this.client
      .from('buses')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Batch insert seats for a bus
   */
  async createSeats(seats: SeatInsert[]): Promise<SeatRow[]> {
    const { data, error } = await this.client
      .from('seats')
      .insert(seats)
      .select();

    if (error) throw error;
    return data || [];
  }
}

import { BaseRepository } from './base.repository.js';
import { Database } from '../types/database.types.js';

type RouteRow = Database['public']['Tables']['routes']['Row'];
type RouteInsert = Database['public']['Tables']['routes']['Insert'];
type RouteUpdate = Database['public']['Tables']['routes']['Update'];

export class RouteRepository extends BaseRepository {
  /**
   * Get all active routes
   */
  async getAllActiveRoutes(): Promise<RouteRow[]> {
    const { data, error } = await this.client
      .from('routes')
      .select('*')
      .eq('is_active', true)
      .order('source_city', { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Search routes connecting two cities
   */
  async findRoutes(sourceCity: string, destinationCity: string): Promise<RouteRow[]> {
    const { data, error } = await this.client
      .from('routes')
      .select('*')
      .ilike('source_city', `%${sourceCity}%`)
      .ilike('destination_city', `%${destinationCity}%`)
      .eq('is_active', true);

    if (error) throw error;
    return data || [];
  }

  /**
   * Get route by ID
   */
  async getRouteById(id: string): Promise<RouteRow | null> {
    const { data, error } = await this.client
      .from('routes')
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
   * Create a new route
   */
  async createRoute(route: RouteInsert): Promise<RouteRow> {
    const { data, error } = await this.client
      .from('routes')
      .insert(route)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Update route
   */
  async updateRoute(id: string, updates: RouteUpdate): Promise<RouteRow> {
    const { data, error } = await this.client
      .from('routes')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }
}

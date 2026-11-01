import {
  routeProblems, type BusLocationEvent, type LngLat, type LocationFix, type PublicBus, type PublicRoute,
  type PublicStop, type RouteConfigInput, type TripDirection, type TripStatus, type TripSummary,
} from '@transitlink/shared';
import type { Db } from './db';

// All SQL lives here. Uses the service-role connection: callers must authorise before calling.

export interface TripRow {
  id: string;
  bus_id: string;
  route_id: string;
  route_version: number;
  route_snapshot: RouteSnapshot;
  direction: TripDirection;
  slot_id: string | null;
  scheduled_departure: Date | null;
  driver_id: string | null;
  status: TripStatus;
  started_at: Date;
  first_fix_at: Date | null;
  departed_at: Date | null;
  arrived_at: Date | null;
  completed_at: Date | null;
  last_sequence: string | number | null;
}

/** Route config frozen at trip start. */
export interface RouteSnapshot {
  route: RouteConfigInput['route'];
  stops: PublicStop[];
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

interface StopRow {
  id: string; name: string; is_college_endpoint: boolean; latitude: number | null; longitude: number | null;
  status: PublicStop['status']; geofence_radius_m: number; location_source: string | null;
}
interface RouteRow {
  id: string; name: string; description_raw: string; version: number; stop_ids: string[]; college_stop_id: string | null;
  geometry: LngLat[] | null; geometry_status: PublicRoute['geometry_status']; geometry_source: string | null; is_active: boolean;
}

export const toPublicStop = (r: StopRow): PublicStop => ({
  id: r.id, name: r.name, is_college_endpoint: r.is_college_endpoint, status: r.status,
  geofence_radius_m: r.geofence_radius_m,
  location: r.latitude === null || r.longitude === null ? null : [r.longitude, r.latitude],
});

export class Repo {
  constructor(readonly db: Db) {}

  // ---- reference data -------------------------------------------------------------------------
  async stops(): Promise<(PublicStop & { location_source: string | null })[]> {
    const { rows } = await this.db.query<StopRow>('select * from public.campus_stops order by name');
    return rows.map((r) => ({ ...toPublicStop(r), location_source: r.location_source }));
  }

  async routes(): Promise<PublicRoute[]> {
    const [{ rows }, stops] = await Promise.all([
      this.db.query<RouteRow>('select * from public.campus_routes where is_active order by name'),
      this.stops(),
    ]);
    const byId = new Map(stops.map((s) => [s.id, s]));
    return rows.map((r) => {
      const route = { id: r.id, version: r.version, stop_ids: r.stop_ids, college_stop_id: r.college_stop_id, geometry: r.geometry, geometry_status: r.geometry_status };
      const problems = routeProblems({ route, stops: byId });
      return { ...route, name: r.name, ready: problems.length === 0, problems };
    });
  }

  async routeConfig(routeId: string): Promise<RouteSnapshot | null> {
    const { rows } = await this.db.query<RouteRow>('select * from public.campus_routes where id = $1', [routeId]);
    const r = rows[0];
    if (!r) return null;
    const { rows: stopRows } = await this.db.query<StopRow>('select * from public.campus_stops where id = any($1::text[])', [r.stop_ids]);
    return {
      route: { id: r.id, version: r.version, stop_ids: r.stop_ids, college_stop_id: r.college_stop_id, geometry: r.geometry, geometry_status: r.geometry_status },
      stops: stopRows.map(toPublicStop),
    };
  }

  async buses(): Promise<PublicBus[]> {
    const { rows } = await this.db.query<PublicBus>(
      'select id, registration_number, fleet_number, seats, route_id, is_active from public.campus_buses order by length(fleet_number), fleet_number');
    return rows;
  }

  async bus(busId: string): Promise<PublicBus | null> {
    const { rows } = await this.db.query<PublicBus>(
      'select id, registration_number, fleet_number, seats, route_id, is_active from public.campus_buses where id = $1', [busId]);
    return rows[0] ?? null;
  }

  // ---- people ---------------------------------------------------------------------------------
  async driverBusId(driverId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ bus_id: string }>(
      `select bus_id from public.campus_driver_assignments
       where driver_id = $1 and valid_from <= now() and (valid_to is null or valid_to > now())
       order by valid_from desc limit 1`, [driverId]);
    return rows[0]?.bus_id ?? null;
  }

  async setDriverAssignment(driverId: string, busId: string | null, adminId: string): Promise<void> {
    await this.db.query('update public.campus_driver_assignments set valid_to = now() where driver_id = $1 and valid_to is null', [driverId]);
    if (busId) {
      await this.db.query('insert into public.campus_driver_assignments (driver_id, bus_id, assigned_by) values ($1, $2, $3)', [driverId, busId, adminId]);
    }
  }

  async studentRoute(studentId: string): Promise<{ route_id: string; stop_id: string | null } | null> {
    const { rows } = await this.db.query<{ route_id: string; stop_id: string | null }>(
      'select route_id, stop_id from public.campus_student_routes where student_id = $1', [studentId]);
    return rows[0] ?? null;
  }

  async setStudentRoute(studentId: string, routeId: string, stopId: string | null): Promise<void> {
    await this.db.query(
      `insert into public.campus_student_routes (student_id, route_id, stop_id) values ($1, $2, $3)
       on conflict (student_id) do update set route_id = excluded.route_id, stop_id = excluded.stop_id`,
      [studentId, routeId, stopId]);
  }

  // ---- trips ----------------------------------------------------------------------------------
  async openTrips(): Promise<TripRow[]> {
    const { rows } = await this.db.query<TripRow>(
      `select * from public.campus_trips where status in ('waiting_for_gps', 'active', 'arrived')`);
    return rows;
  }

  async insertTrip(t: {
    bus_id: string; route_id: string; route_version: number; route_snapshot: RouteSnapshot; direction: TripDirection;
    slot_id: string | null; scheduled_departure: Date | null; driver_id: string;
  }): Promise<TripRow> {
    const { rows } = await this.db.query<TripRow>(
      `insert into public.campus_trips (bus_id, route_id, route_version, route_snapshot, direction, slot_id, scheduled_departure, driver_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [t.bus_id, t.route_id, t.route_version, JSON.stringify(t.route_snapshot), t.direction, t.slot_id, t.scheduled_departure, t.driver_id]);
    return rows[0]!;
  }

  async updateTrip(id: string, s: TripSummary, lastSequence: number | null, endReason?: string): Promise<void> {
    await this.db.query(
      `update public.campus_trips set status = $2, first_fix_at = $3, departed_at = $4, arrived_at = $5, completed_at = $6,
         last_sequence = $7, end_reason = coalesce($8, end_reason) where id = $1`,
      [id, s.status, s.first_fix_at, s.departed_at, s.arrived_at, s.completed_at, lastSequence, endReason ?? null]);
  }

  async saveFix(e: BusLocationEvent, fix: LocationFix, live: boolean): Promise<void> {
    await this.db.query(
      `insert into public.campus_bus_locations (bus_id, trip_id, source, latitude, longitude, accuracy_m, speed_mps, heading_deg,
         sequence, measured_at, received_at, along_m, on_route, live)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0), to_timestamp($11 / 1000.0), $12, $13, $14)`,
      [e.bus_id, e.trip_id, fix.source, fix.latitude, fix.longitude, fix.accuracy_m, fix.speed_mps, fix.heading_deg,
        fix.sequence, fix.measured_at, e.received_at, e.route?.along_m ?? null, e.route?.on_route ?? null, live]);
    if (!live) return;
    await this.db.query(
      `insert into public.campus_bus_latest_locations (bus_id, trip_id, source, latitude, longitude, accuracy_m, speed_mps,
         heading_deg, quality, sequence, measured_at, received_at, route_progress)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11 / 1000.0), to_timestamp($12 / 1000.0), $13)
       on conflict (bus_id) do update set trip_id = excluded.trip_id, source = excluded.source, latitude = excluded.latitude,
         longitude = excluded.longitude, accuracy_m = excluded.accuracy_m, speed_mps = excluded.speed_mps,
         heading_deg = excluded.heading_deg, quality = excluded.quality, sequence = excluded.sequence,
         measured_at = excluded.measured_at, received_at = excluded.received_at, route_progress = excluded.route_progress`,
      [e.bus_id, e.trip_id, e.source, fix.latitude, fix.longitude, fix.accuracy_m, fix.speed_mps, fix.heading_deg, e.quality,
        fix.sequence, fix.measured_at, e.received_at, e.route ? JSON.stringify(e.route) : null]);
  }

  /** Last accepted live fix of a trip, to resume after a server restart. */
  async lastFix(tripId: string): Promise<LocationFix | null> {
    const { rows } = await this.db.query<{
      latitude: number; longitude: number; accuracy_m: number | null; speed_mps: number | null; heading_deg: number | null;
      measured_at: Date; sequence: string; source: LocationFix['source'];
    }>(`select latitude, longitude, accuracy_m, speed_mps, heading_deg, measured_at, sequence, source
        from public.campus_bus_locations where trip_id = $1 and live order by sequence desc limit 1`, [tripId]);
    const r = rows[0];
    if (!r) return null;
    return {
      latitude: r.latitude, longitude: r.longitude, accuracy_m: r.accuracy_m, speed_mps: r.speed_mps, heading_deg: r.heading_deg,
      measured_at: new Date(r.measured_at).getTime(), sequence: Number(r.sequence), source: r.source,
    };
  }

  async purgeHistory(retainDays: number): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>('select public.campus_purge_location_history($1) as n', [retainDays]);
    return Number(rows[0]?.n ?? 0);
  }

  // ---- schedule slots -------------------------------------------------------------------------
  async slots(): Promise<{ id: string; local_time: string; direction: TripDirection; label: string; csv_shift_index: number | null }[]> {
    const { rows } = await this.db.query<{ id: string; local_time: string; direction: TripDirection; label: string; csv_shift_index: number | null }>(
      `select id, to_char(local_time, 'HH24:MI') as local_time, direction, label, csv_shift_index
       from public.campus_departure_slots where is_active order by local_time`);
    return rows;
  }

  async busShifts(busIds?: string[]) {
    const { rows } = await this.db.query<{ bus_id: string; shift_index: number; raw: string; local_time: string | null; no_service: boolean }>(
      `select bus_id, shift_index, raw, to_char(local_time, 'HH24:MI') as local_time, no_service from public.campus_bus_shifts
       ${busIds ? 'where bus_id = any($1::text[])' : ''} order by bus_id, shift_index`, busIds ? [busIds] : []);
    return rows;
  }

  async slotDecisions(): Promise<Record<string, 'confirmed' | 'cancelled'>> {
    const { rows } = await this.db.query<{ bus_id: string; slot_id: string; decision: 'confirmed' | 'cancelled' }>(
      'select bus_id, slot_id, decision from public.campus_slot_decisions');
    return Object.fromEntries(rows.map((r) => [`${r.bus_id}|${r.slot_id}`, r.decision]));
  }

  async setSlotDecision(busId: string, slotId: string, decision: 'confirmed' | 'cancelled' | null, note: string | null, adminId: string) {
    if (decision === null) {
      await this.db.query('delete from public.campus_slot_decisions where bus_id = $1 and slot_id = $2', [busId, slotId]);
      return;
    }
    await this.db.query(
      `insert into public.campus_slot_decisions (bus_id, slot_id, decision, note, decided_by) values ($1, $2, $3, $4, $5)
       on conflict (bus_id, slot_id) do update set decision = excluded.decision, note = excluded.note,
         decided_by = excluded.decided_by, decided_at = now()`,
      [busId, slotId, decision, note, adminId]);
  }

  // ---- admin configuration --------------------------------------------------------------------
  async setStopLocation(stopId: string, s: { location: LngLat | null; status: PublicStop['status']; source: string | null; radius?: number }, adminId: string) {
    const { rows } = await this.db.query<StopRow>(
      `update public.campus_stops set latitude = $2, longitude = $3, status = $4::public.campus_review_status,
         location_source = $5, geofence_radius_m = coalesce($6::integer, geofence_radius_m),
         verified_by = case when $4::public.campus_review_status = 'verified' then $7::uuid else null end,
         verified_at = case when $4::public.campus_review_status = 'verified' then now() else null end
       where id = $1 returning *`,
      [stopId, s.location?.[1] ?? null, s.location?.[0] ?? null, s.status, s.source, s.radius ?? null, adminId]);
    if (rows[0]) await this.bumpRoutesUsingStop(stopId);
    return rows[0] ? toPublicStop(rows[0]) : null;
  }

  /** Any change to a stop changes every route through it; trips already running keep their snapshot. */
  private async bumpRoutesUsingStop(stopId: string) {
    await this.db.query('update public.campus_routes set version = version + 1 where $1 = any(stop_ids)', [stopId]);
  }

  async setRouteGeometry(routeId: string, geometry: LngLat[] | null, status: PublicRoute['geometry_status'], source: string | null, adminId: string) {
    const { rows } = await this.db.query(
      `update public.campus_routes set geometry = $2::jsonb, geometry_status = $3::text, geometry_source = $4, version = version + 1,
         geometry_verified_by = case when $3::text = 'verified' then $5::uuid else null end,
         geometry_verified_at = case when $3::text = 'verified' then now() else null end
       where id = $1 returning id`,
      [routeId, geometry ? JSON.stringify(geometry) : null, status, source, adminId]);
    return rows.length > 0;
  }
}

export function tripSummary(row: TripRow, ready: boolean, problems: string[]): TripSummary {
  return {
    id: row.id, bus_id: row.bus_id, route_id: row.route_id, route_version: row.route_version, direction: row.direction,
    status: row.status, slot_id: row.slot_id, scheduled_departure: iso(row.scheduled_departure),
    started_at: iso(row.started_at)!, first_fix_at: iso(row.first_fix_at), departed_at: iso(row.departed_at),
    arrived_at: iso(row.arrived_at), completed_at: iso(row.completed_at), route_ready: ready, route_problems: problems,
  };
}

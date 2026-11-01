import { createHash } from 'node:crypto';
import { parseSchedule, type ParseScheduleOptions, type ScheduleIssue } from '@transitlink/shared';
import type { Db } from './db';

export interface ImportResult {
  import_id: string;
  records: number;
  buses_upserted: number;
  buses_skipped: { record: number; registration: string; reason: string }[];
  buses_deactivated: number;
  routes_active: number;
  routes_deactivated: number;
  stops: number;
  issues: ScheduleIssue[];
}

/**
 * Loads the schedule CSV into the campus_* tables in one transaction.
 *
 * Safe to re-run when the CSV changes: stop coordinates and route geometry (admin-verified) are never
 * overwritten, buses/routes missing from the new file are deactivated rather than deleted, and running
 * trips are untouched because each trip keeps a frozen route snapshot.
 */
export async function importSchedule(
  db: Db, csvText: string, opts: ParseScheduleOptions & { fileName?: string; importedBy?: string | null } = {},
): Promise<ImportResult> {
  const parsed = parseSchedule(csvText, opts);
  const sha = createHash('sha256').update(csvText).digest('hex');
  const duplicateRecords = new Set(parsed.issues.filter((i) => i.code === 'duplicate_registration').map((i) => i.record));

  return db.transaction(async (tx) => {
    const { rows: [imp] } = await tx.query<{ id: string }>(
      `insert into public.campus_schedule_imports (file_sha256, file_name, record_count, issues, imported_by)
       values ($1, $2, $3, $4, $5) returning id`,
      [sha, opts.fileName ?? null, parsed.records.length, JSON.stringify(parsed.issues), opts.importedBy ?? null]);
    const importId = imp!.id;

    for (const r of parsed.records) {
      await tx.query('insert into public.campus_schedule_rows (import_id, record, raw) values ($1, $2, $3)', [importId, r.record, JSON.stringify(r.raw)]);
    }

    for (const s of parsed.stops) {
      // Coordinates/status are admin-managed: only the name and endpoint flag come from the CSV.
      await tx.query(
        `insert into public.campus_stops (id, name, is_college_endpoint) values ($1, $2, $3)
         on conflict (id) do update set name = excluded.name, is_college_endpoint = excluded.is_college_endpoint`,
        [s.id, s.name, s.is_college_endpoint]);
    }

    for (const r of parsed.routes) {
      // Route ids are derived from the stop sequence, so an id's stop list never changes.
      await tx.query(
        `insert into public.campus_routes (id, name, description_raw, stop_ids, college_stop_id, is_active)
         values ($1, $2, $3, $4, $5, true)
         on conflict (id) do update set name = excluded.name, description_raw = excluded.description_raw, is_active = true`,
        [r.id, r.name, r.description_raw, r.stop_ids, r.college_stop_id]);
    }
    const { rows: deactivatedRoutes } = await tx.query(
      'update public.campus_routes set is_active = false where is_active and not (id = any($1::text[])) returning id',
      [parsed.routes.map((r) => r.id)]);

    const skipped: ImportResult['buses_skipped'] = [];
    const imported: string[] = [];
    for (const b of parsed.buses) {
      if (!b.registration_number || duplicateRecords.has(b.record)) {
        skipped.push({ record: b.record, registration: b.registration_raw, reason: b.registration_number ? 'duplicate registration' : 'missing registration' });
        continue;
      }
      await tx.query(
        `insert into public.campus_buses (id, registration_number, registration_raw, fleet_number, seats, route_id, csv_record, is_active, last_import_id)
         values ($1, $2, $3, $4, $5, $6, $7, true, $8)
         on conflict (id) do update set registration_raw = excluded.registration_raw, fleet_number = excluded.fleet_number,
           seats = excluded.seats, route_id = excluded.route_id, csv_record = excluded.csv_record, is_active = true,
           last_import_id = excluded.last_import_id`,
        [b.id, b.registration_number, b.registration_raw, b.fleet_number, b.seats, b.route_id, b.record, importId]);
      await tx.query(
        `insert into public.campus_bus_driver_contacts (bus_id, driver_name, contact_no) values ($1, $2, $3)
         on conflict (bus_id) do update set driver_name = excluded.driver_name, contact_no = excluded.contact_no`,
        [b.id, b.driver_name, b.driver_contact]);
      await tx.query('delete from public.campus_bus_shifts where bus_id = $1', [b.id]);
      for (const s of b.shift) {
        await tx.query(
          'insert into public.campus_bus_shifts (bus_id, shift_index, raw, local_time, no_service) values ($1, $2, $3, $4, $5)',
          [b.id, s.index, s.raw, s.time, s.no_service]);
      }
      imported.push(b.id);
    }
    const { rows: deactivatedBuses } = await tx.query(
      'update public.campus_buses set is_active = false where is_active and not (id = any($1::text[])) returning id', [imported]);

    return {
      import_id: importId,
      records: parsed.records.length,
      buses_upserted: imported.length,
      buses_skipped: skipped,
      buses_deactivated: deactivatedBuses.length,
      routes_active: parsed.routes.length,
      routes_deactivated: deactivatedRoutes.length,
      stops: parsed.stops.length,
      issues: parsed.issues,
    };
  });
}

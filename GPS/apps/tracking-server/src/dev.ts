// LOCAL DEVELOPMENT ONLY — runs the real server against an in-memory Postgres (PGlite) with the real
// migrations, imports the schedule CSV, and creates three dev accounts. No Supabase or Docker needed.
// Data is lost on exit. Never deploy this entry point.
//
//   npm run dev:local -w @transitlink/tracking-server            (expects ../../data/SafarSaathi_Bus_Schedule.csv)

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestDb, createUser } from '../test/pgliteDb';
import { createTrackingServer } from './app';
import { DevAuthenticator } from './auth';
import { loadConfig } from './config';
import { importSchedule } from './importer';

if (process.env.NODE_ENV === 'production') throw new Error('dev.ts must not run in production');

const USERS = {
  admin: '00000000-0000-4000-8000-00000000a001',
  driver: '00000000-0000-4000-8000-00000000d001',
  student: '00000000-0000-4000-8000-000000005001',
};

// Extra driver accounts (d002-d008) for simulating several buses at once; an admin assigns each to a
// bus with PUT /api/admin/drivers/:userId/assignment.
const EXTRA_DRIVERS = Array.from({ length: 7 }, (_, i) => `00000000-0000-4000-8000-00000000d00${i + 2}`);

const cfg = loadConfig({ ...process.env, DEV_AUTH: '1' });
const { db } = await createTestDb();
for (const [role, id] of Object.entries(USERS)) await createUser(db, id, role);
for (const id of EXTRA_DRIVERS) await createUser(db, id, 'driver');

const csvPath = resolve(process.env.SCHEDULE_CSV ?? '../../data/SafarSaathi_Bus_Schedule.csv');
if (existsSync(csvPath)) {
  const r = await importSchedule(db, readFileSync(csvPath, 'utf8'), { fileName: 'SafarSaathi_Bus_Schedule.csv' });
  console.log(`[dev] imported ${r.buses_upserted} buses, ${r.routes_active} routes, ${r.stops} stops (${r.issues.length} review notes)`);
  const firstBus = (await db.query<{ id: string }>('select id from public.campus_buses order by csv_record limit 1')).rows[0];
  if (firstBus) {
    await db.query('insert into public.campus_driver_assignments (driver_id, bus_id) values ($1, $2)', [USERS.driver, firstBus.id]);
    console.log(`[dev] dev driver assigned to ${firstBus.id}`);
  }
} else {
  console.warn(`[dev] ${csvPath} not found — starting with an empty schedule`);
}

// Testing only: DEV_BUS_SEATS='{"bus-uk07pa1696":1}' shrinks a bus so "full" can be tried with one
// person in front of a webcam. The vision bridge must report the same capacity (VISION_CAPACITY=1).
for (const [busId, seats] of Object.entries(JSON.parse(process.env.DEV_BUS_SEATS || '{}') as Record<string, number>)) {
  if (!Number.isInteger(seats) || seats < 1) throw new Error(`DEV_BUS_SEATS: ${busId} needs a whole number of seats >= 1`);
  await db.query('update public.campus_buses set seats = $2 where id = $1', [busId, seats]);
  console.log(`[dev] TEST: ${busId} has ${seats} seat(s)`);
}

const server = await createTrackingServer(db, new DevAuthenticator(db), cfg);
setInterval(() => void server.tracker.sweep(), 1000);
server.seats.start();
server.http.listen(cfg.port, () => {
  console.log(`[dev] tracking server on http://localhost:${cfg.port} (in-memory database)`);
  for (const [role, id] of Object.entries(USERS)) console.log(`[dev]   ${role.padEnd(7)} token: dev:${id}`);
  console.log(`[dev]   + ${EXTRA_DRIVERS.length} unassigned drivers: dev:...d002 to dev:...d008`);
});

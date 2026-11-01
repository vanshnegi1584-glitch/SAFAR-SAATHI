import { describe, expect, it } from 'vitest';
import { createTestDb, createUser, hasMigrations } from './pgliteDb';

const asUser = (sub: string) => `set local role authenticated; select set_config('request.jwt.claim.sub', '${sub}', true);`;

describe.skipIf(!hasMigrations)('Supabase migrations (PGlite)', () => {
  it('apply cleanly and enforce the security fixes', async () => {
    const { db, pg } = await createTestDb();
    await pg.exec(`do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
      grant usage on schema public to authenticated; grant select, insert, update on all tables in schema public to authenticated;
      grant usage on all sequences in schema public to authenticated;`); // mirrors Supabase's default grants

    // Self-registering as admin is downgraded to passenger.
    await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a1', 'x@y', '{"role":"admin"}')`);
    const { rows } = await db.query<{ role: string }>(`select role from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'`);
    expect(rows[0]!.role).toBe('passenger');

    // A user cannot promote themselves.
    await expect(pg.transaction(async (tx) => {
      await tx.exec(asUser('00000000-0000-0000-0000-0000000000a1'));
      await tx.exec(`update public.profiles set role = 'admin' where id = '00000000-0000-0000-0000-0000000000a1'`);
    })).rejects.toThrow(/admin/);

    // Students only see live locations for their own route.
    await createUser(db, '00000000-0000-0000-0000-0000000000b1', 'student');
    await createUser(db, '00000000-0000-0000-0000-0000000000b2', 'student');
    await pg.exec(`
      insert into public.campus_stops (id, name, is_college_endpoint) values ('s1','S1',false), ('geu','GEU',true);
      insert into public.campus_routes (id, name, description_raw, stop_ids, college_stop_id) values
        ('r1','R1','S1-GEU', array['s1','geu'], 'geu'), ('r2','R2','S1-GEU', array['s1','geu'], 'geu');
      insert into public.campus_buses (id, registration_number, registration_raw, fleet_number, route_id) values ('bus-a','A','A','1','r1');
      insert into public.campus_trips (id, bus_id, route_id, route_version, route_snapshot, direction, status)
        values ('00000000-0000-0000-0000-00000000c001','bus-a','r1',1,'{}','TO_COLLEGE','active');
      insert into public.campus_bus_latest_locations (bus_id, trip_id, source, latitude, longitude, quality, sequence, measured_at, received_at)
        values ('bus-a','00000000-0000-0000-0000-00000000c001','driver_device',30.3,78.0,'good',1,now(),now());
      insert into public.campus_student_routes (student_id, route_id) values
        ('00000000-0000-0000-0000-0000000000b1','r1'), ('00000000-0000-0000-0000-0000000000b2','r2');
    `);
    const visible = async (sub: string) => pg.transaction(async (tx) => {
      await tx.exec(asUser(sub));
      return (await tx.query('select bus_id from public.campus_bus_latest_locations')).rows.length;
    });
    expect(await visible('00000000-0000-0000-0000-0000000000b1')).toBe(1);
    expect(await visible('00000000-0000-0000-0000-0000000000b2')).toBe(0);

    // Clients cannot write locations directly — only the server (service role) can.
    await expect(pg.transaction(async (tx) => {
      await tx.exec(asUser('00000000-0000-0000-0000-0000000000b1'));
      await tx.exec(`insert into public.campus_bus_locations (bus_id, trip_id, source, latitude, longitude, sequence, measured_at)
        values ('bus-a','00000000-0000-0000-0000-00000000c001','driver_device',30.3,78.0,2,now())`);
    })).rejects.toThrow(/row-level security/);

    // Only one open trip per bus.
    await expect(db.query(`insert into public.campus_trips (bus_id, route_id, route_version, route_snapshot, direction)
      values ('bus-a','r1',1,'{}','FROM_COLLEGE')`)).rejects.toThrow(/campus_one_open_trip_per_bus/);
  });
});

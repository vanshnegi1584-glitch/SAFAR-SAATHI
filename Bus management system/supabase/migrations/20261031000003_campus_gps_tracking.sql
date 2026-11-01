-- ==============================================================================
-- SafarSaathi - Campus tracking, part 2: college bus schedule, routes, live GPS
--
-- Additive: the intercity booking tables (buses, routes, trips, bus_locations) are
-- left in place. Campus data lives in campus_* tables because the booking tables
-- enforce invariants campus data cannot meet without invented values (fares,
-- distance_km > 0, arrival_time > departure_time, uuid ids).
--
-- Writes to campus location/trip tables are made by the tracking server with the
-- service role (bypasses RLS) after server-side validation. Clients get read-only
-- access through the policies below; they can never write locations directly.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- Security fixes to the existing schema (found while integrating tracking)
-- ------------------------------------------------------------------------------

-- 1. Signup trusted raw_user_meta_data.role, so anyone could self-register as admin.
--    Only self-service roles may be chosen at signup; staff roles are granted by an admin.
create or replace function public.handle_new_user()
returns trigger as $$
declare
    requested text := new.raw_user_meta_data->>'role';
begin
    insert into public.profiles (id, email, full_name, phone, role)
    values (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data->>'full_name', 'Passenger'),
        new.raw_user_meta_data->>'phone',
        case when requested in ('passenger', 'student') then requested::public.user_role
             else 'passenger'::public.user_role end
    );
    return new;
end;
$$ language plpgsql security definer set search_path = public;

-- 2. Users could change their own role via "Users can update own profile".
create or replace function public.prevent_self_role_change()
returns trigger as $$
begin
    if new.role is distinct from old.role and coalesce(auth.uid() = old.id, false)
       and not exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') then
        raise exception 'role can only be changed by an admin';
    end if;
    return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger profiles_prevent_self_role_change before update on public.profiles
for each row execute procedure public.prevent_self_role_change();

-- Role lookup for policies (security definer avoids recursive RLS on profiles).
create or replace function public.app_user_role()
returns public.user_role as $$
    select role from public.profiles where id = auth.uid()
$$ language sql stable security definer set search_path = public;

-- 3. bus_locations was readable by everyone (including anonymous users) and any
--    driver could insert positions for any bus.
drop policy if exists "Anyone can read bus locations" on public.bus_locations;
drop policy if exists "Drivers and Operators can insert bus locations" on public.bus_locations;

create policy "Staff, the trip's driver, and booked passengers can read bus locations" on public.bus_locations
    for select using (
        public.app_user_role() in ('admin', 'operator')
        or exists (select 1 from public.trips t where t.id = bus_locations.trip_id and t.driver_id = auth.uid())
        or exists (
            select 1 from public.bookings b
            where b.trip_id = bus_locations.trip_id and b.user_id = auth.uid()
              and b.booking_status in ('confirmed', 'completed')
        )
    );

create policy "Staff, or the trip's assigned driver, can insert bus locations" on public.bus_locations
    for insert with check (
        public.app_user_role() in ('admin', 'operator')
        or exists (
            select 1 from public.trips t
            where t.id = bus_locations.trip_id and t.bus_id = bus_locations.bus_id and t.driver_id = auth.uid()
        )
    );

-- ------------------------------------------------------------------------------
-- Enums
-- ------------------------------------------------------------------------------
create type public.campus_trip_direction as enum ('TO_COLLEGE', 'FROM_COLLEGE');
create type public.campus_trip_status as enum ('waiting_for_gps', 'active', 'arrived', 'completed', 'cancelled');
create type public.campus_review_status as enum ('unverified', 'candidate', 'verified');
create type public.campus_slot_decision as enum ('confirmed', 'cancelled');

-- ------------------------------------------------------------------------------
-- Static schedule (from SafarSaathi_Bus_Schedule.csv)
-- ------------------------------------------------------------------------------

-- Every import keeps the verbatim CSV cells, so the original schedule is never lost.
create table public.campus_schedule_imports (
    id uuid primary key default gen_random_uuid(),
    file_sha256 text not null,
    file_name text,
    record_count integer not null check (record_count >= 0),
    issues jsonb not null default '[]'::jsonb,
    imported_by uuid references public.profiles(id) on delete set null,
    imported_at timestamptz not null default now()
);

create table public.campus_schedule_rows (
    import_id uuid not null references public.campus_schedule_imports(id) on delete cascade,
    record integer not null,
    raw jsonb not null,
    primary key (import_id, record)
);

create table public.campus_stops (
    id text primary key,
    name text not null,
    is_college_endpoint boolean not null default false,
    latitude double precision check (latitude between -90 and 90),
    longitude double precision check (longitude between -180 and 180),
    status public.campus_review_status not null default 'unverified',
    -- Where a candidate/verified coordinate came from, e.g. 'nominatim:<osm id>' or 'manual-map'.
    location_source text,
    geofence_radius_m integer not null default 60 check (geofence_radius_m between 15 and 500),
    verified_by uuid references public.profiles(id) on delete set null,
    verified_at timestamptz,
    updated_at timestamptz not null default now(),
    constraint campus_stop_coords_pair check ((latitude is null) = (longitude is null)),
    constraint campus_stop_verified_has_coords check (status = 'unverified' or latitude is not null)
);

create table public.campus_routes (
    id text primary key,
    name text not null,
    description_raw text not null,
    -- Bumped whenever stops or geometry change; trips keep the version they started with.
    version integer not null default 1 check (version > 0),
    -- Ordered stop ids in CSV order (= TO_COLLEGE). May repeat a stop.
    stop_ids text[] not null check (cardinality(stop_ids) >= 2),
    college_stop_id text references public.campus_stops(id),
    -- [[lng, lat], ...] road-following path in TO_COLLEGE order; null until configured.
    geometry jsonb check (geometry is null or jsonb_typeof(geometry) = 'array'),
    geometry_status text not null default 'missing' check (geometry_status in ('missing', 'candidate', 'verified')),
    geometry_source text,
    geometry_verified_by uuid references public.profiles(id) on delete set null,
    geometry_verified_at timestamptz,
    is_active boolean not null default true,
    updated_at timestamptz not null default now(),
    constraint campus_route_geometry_state check (geometry_status = 'missing' or geometry is not null)
);

create table public.campus_buses (
    id text primary key,
    registration_number text not null unique,
    registration_raw text not null,
    fleet_number text not null,
    seats integer check (seats > 0),
    route_id text references public.campus_routes(id) on delete set null,
    csv_record integer,
    is_active boolean not null default true,
    last_import_id uuid references public.campus_schedule_imports(id) on delete set null,
    updated_at timestamptz not null default now()
);

-- Driver names and personal phone numbers: staff only.
create table public.campus_bus_driver_contacts (
    bus_id text primary key references public.campus_buses(id) on delete cascade,
    driver_name text,
    contact_no text,
    updated_at timestamptz not null default now()
);

create table public.campus_bus_shifts (
    bus_id text not null references public.campus_buses(id) on delete cascade,
    shift_index integer not null check (shift_index >= 0),
    raw text not null,
    local_time time,
    no_service boolean not null default false,
    primary key (bus_id, shift_index),
    constraint campus_shift_time_or_no_service check (not (no_service and local_time is not null))
);

-- Application departure slots (Asia/Kolkata). Configurable rows, not hardcoded in clients.
create table public.campus_departure_slots (
    id text primary key,
    local_time time not null,
    direction public.campus_trip_direction not null,
    label text not null,
    csv_shift_index integer,
    is_active boolean not null default true
);

insert into public.campus_departure_slots (id, local_time, direction, label, csv_shift_index) values
    ('am-0700', '07:00', 'TO_COLLEGE', 'Morning pickup 7:00 AM', 0),
    ('am-1100', '11:00', 'TO_COLLEGE', 'Morning pickup 11:00 AM', 1),
    ('pm-1300', '13:00', 'FROM_COLLEGE', 'Departure 1:00 PM', null),
    ('pm-1600', '16:00', 'FROM_COLLEGE', 'Departure 4:00 PM', null),
    ('pm-1800', '18:00', 'FROM_COLLEGE', 'Departure 6:00 PM', null);

-- Admin decisions resolving CSV/slot conflicts and unconfirmed afternoon slots.
create table public.campus_slot_decisions (
    bus_id text not null references public.campus_buses(id) on delete cascade,
    slot_id text not null references public.campus_departure_slots(id) on delete cascade,
    decision public.campus_slot_decision not null,
    note text,
    decided_by uuid references public.profiles(id) on delete set null,
    decided_at timestamptz not null default now(),
    primary key (bus_id, slot_id)
);

-- ------------------------------------------------------------------------------
-- People ↔ buses/routes
-- ------------------------------------------------------------------------------

-- Which driver account may publish GPS for which bus. Created by an admin; the CSV's
-- driver name is not proof of identity.
create table public.campus_driver_assignments (
    id uuid primary key default gen_random_uuid(),
    driver_id uuid not null references public.profiles(id) on delete cascade,
    bus_id text not null references public.campus_buses(id) on delete cascade,
    valid_from timestamptz not null default now(),
    valid_to timestamptz,
    assigned_by uuid references public.profiles(id) on delete set null,
    constraint campus_assignment_period check (valid_to is null or valid_to > valid_from)
);
create unique index campus_one_open_assignment_per_driver
    on public.campus_driver_assignments(driver_id) where valid_to is null;

-- The route (and stop) a student follows; limits which buses they can see.
create table public.campus_student_routes (
    student_id uuid primary key references public.profiles(id) on delete cascade,
    route_id text not null references public.campus_routes(id) on delete cascade,
    stop_id text references public.campus_stops(id) on delete set null,
    updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------------------
-- Live trips and telemetry (kept separate from the static schedule)
-- ------------------------------------------------------------------------------
create table public.campus_trips (
    id uuid primary key default gen_random_uuid(),
    bus_id text not null references public.campus_buses(id) on delete restrict,
    route_id text not null references public.campus_routes(id) on delete restrict,
    route_version integer not null,
    -- Frozen copy of stops + geometry at trip start, so a schedule reload cannot change a live trip.
    route_snapshot jsonb not null,
    direction public.campus_trip_direction not null,
    slot_id text references public.campus_departure_slots(id) on delete set null,
    scheduled_departure timestamptz,
    driver_id uuid references public.profiles(id) on delete set null,
    status public.campus_trip_status not null default 'waiting_for_gps',
    started_at timestamptz not null default now(),
    first_fix_at timestamptz,
    departed_at timestamptz,
    arrived_at timestamptz,
    completed_at timestamptz,
    end_reason text,
    last_sequence bigint
);
create unique index campus_one_open_trip_per_bus
    on public.campus_trips(bus_id) where status in ('waiting_for_gps', 'active', 'arrived');
create index idx_campus_trips_route_status on public.campus_trips(route_id, status);

-- Authoritative latest accepted fix per bus.
create table public.campus_bus_latest_locations (
    bus_id text primary key references public.campus_buses(id) on delete cascade,
    trip_id uuid not null references public.campus_trips(id) on delete cascade,
    source text not null check (source in ('driver_device', 'vehicle_tracker')),
    latitude double precision not null check (latitude between -90 and 90),
    longitude double precision not null check (longitude between -180 and 180),
    accuracy_m real,
    speed_mps real,
    heading_deg real,
    quality text not null check (quality in ('good', 'fair', 'poor')),
    sequence bigint not null,
    measured_at timestamptz not null,
    received_at timestamptz not null,
    route_progress jsonb
);

-- Location history. Retention: see campus_purge_location_history().
create table public.campus_bus_locations (
    id bigserial primary key,
    bus_id text not null references public.campus_buses(id) on delete cascade,
    trip_id uuid not null references public.campus_trips(id) on delete cascade,
    source text not null,
    latitude double precision not null,
    longitude double precision not null,
    accuracy_m real,
    speed_mps real,
    heading_deg real,
    sequence bigint not null,
    measured_at timestamptz not null,
    received_at timestamptz not null default now(),
    along_m real,
    on_route boolean,
    live boolean not null default true
);
create index idx_campus_bus_locations_trip on public.campus_bus_locations(trip_id, measured_at);
create index idx_campus_bus_locations_received on public.campus_bus_locations(received_at);

create or replace function public.campus_purge_location_history(retain_days integer default 30)
returns bigint as $$
declare
    deleted bigint;
begin
    delete from public.campus_bus_locations where received_at < now() - make_interval(days => retain_days);
    get diagnostics deleted = row_count;
    return deleted;
end;
$$ language plpgsql security definer set search_path = public;

-- updated_at maintenance (reuses the function from the initial migration)
create trigger update_campus_stops_modtime before update on public.campus_stops
for each row execute procedure public.update_updated_at_column();
create trigger update_campus_routes_modtime before update on public.campus_routes
for each row execute procedure public.update_updated_at_column();
create trigger update_campus_buses_modtime before update on public.campus_buses
for each row execute procedure public.update_updated_at_column();
create trigger update_campus_contacts_modtime before update on public.campus_bus_driver_contacts
for each row execute procedure public.update_updated_at_column();
create trigger update_campus_student_routes_modtime before update on public.campus_student_routes
for each row execute procedure public.update_updated_at_column();

-- ------------------------------------------------------------------------------
-- Row level security (read paths for direct Supabase clients)
-- ------------------------------------------------------------------------------
alter table public.campus_schedule_imports enable row level security;
alter table public.campus_schedule_rows enable row level security;
alter table public.campus_stops enable row level security;
alter table public.campus_routes enable row level security;
alter table public.campus_buses enable row level security;
alter table public.campus_bus_driver_contacts enable row level security;
alter table public.campus_bus_shifts enable row level security;
alter table public.campus_departure_slots enable row level security;
alter table public.campus_slot_decisions enable row level security;
alter table public.campus_driver_assignments enable row level security;
alter table public.campus_student_routes enable row level security;
alter table public.campus_trips enable row level security;
alter table public.campus_bus_latest_locations enable row level security;
alter table public.campus_bus_locations enable row level security;

-- Staff manage everything.
create policy "Staff manage schedule imports" on public.campus_schedule_imports for all
    using (public.app_user_role() in ('admin', 'operator'));
create policy "Staff manage schedule rows" on public.campus_schedule_rows for all
    using (public.app_user_role() in ('admin', 'operator'));
create policy "Staff manage driver contacts" on public.campus_bus_driver_contacts for all
    using (public.app_user_role() in ('admin', 'operator'));
create policy "Staff manage slot decisions" on public.campus_slot_decisions for all
    using (public.app_user_role() in ('admin', 'operator'));
create policy "Admins manage stops" on public.campus_stops for all
    using (public.app_user_role() = 'admin');
create policy "Admins manage routes" on public.campus_routes for all
    using (public.app_user_role() = 'admin');
create policy "Admins manage buses" on public.campus_buses for all
    using (public.app_user_role() = 'admin');
create policy "Admins manage driver assignments" on public.campus_driver_assignments for all
    using (public.app_user_role() = 'admin');
create policy "Staff read location history" on public.campus_bus_locations for select
    using (public.app_user_role() in ('admin', 'operator'));

-- Public-to-signed-in reference data (no personal information in these tables).
create policy "Signed-in users read stops" on public.campus_stops for select using (auth.uid() is not null);
create policy "Signed-in users read routes" on public.campus_routes for select using (auth.uid() is not null and is_active);
create policy "Signed-in users read buses" on public.campus_buses for select using (auth.uid() is not null and is_active);
create policy "Signed-in users read bus shifts" on public.campus_bus_shifts for select using (auth.uid() is not null);
create policy "Signed-in users read departure slots" on public.campus_departure_slots for select using (auth.uid() is not null);

-- Drivers see their own assignment; students manage their own route choice.
create policy "Drivers read own assignments" on public.campus_driver_assignments for select
    using (driver_id = auth.uid());
create policy "Students read own route" on public.campus_student_routes for select
    using (student_id = auth.uid() or public.app_user_role() in ('admin', 'operator'));
create policy "Students set own route" on public.campus_student_routes for insert
    with check (student_id = auth.uid() and public.app_user_role() = 'student');
create policy "Students change own route" on public.campus_student_routes for update
    using (student_id = auth.uid()) with check (student_id = auth.uid());

-- Trips and live positions: staff; the driver of the trip; students on that route while it runs.
create policy "Trips visible to staff, own driver, and route students" on public.campus_trips for select
    using (
        public.app_user_role() in ('admin', 'operator')
        or driver_id = auth.uid()
        or (status in ('waiting_for_gps', 'active', 'arrived') and exists (
            select 1 from public.campus_student_routes sr
            where sr.student_id = auth.uid() and sr.route_id = campus_trips.route_id
        ))
    );

create policy "Latest locations visible to staff, own driver, and route students" on public.campus_bus_latest_locations for select
    using (
        public.app_user_role() in ('admin', 'operator')
        or exists (
            select 1 from public.campus_trips t
            where t.id = campus_bus_latest_locations.trip_id
              and t.status in ('waiting_for_gps', 'active', 'arrived')
              and (t.driver_id = auth.uid() or exists (
                  select 1 from public.campus_student_routes sr
                  where sr.student_id = auth.uid() and sr.route_id = t.route_id
              ))
        )
    );

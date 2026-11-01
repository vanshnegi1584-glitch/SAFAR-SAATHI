-- ==============================================================================
-- SafarSaathi (सफर साथी) - Bus Management System Database Schema
-- Migration: Initial Schema Setup
-- ==============================================================================

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ==============================================================================
-- ENUMS
-- ==============================================================================
create type public.user_role as enum ('admin', 'operator', 'driver', 'conductor', 'passenger');
create type public.bus_type as enum ('standard', 'deluxe', 'ac_sleeper', 'non_ac_sleeper', 'volvo_multi_axle', 'electric');
create type public.seat_type as enum ('window', 'aisle', 'sleeper_lower', 'sleeper_upper');
create type public.trip_status as enum ('scheduled', 'boarding', 'in_transit', 'delayed', 'completed', 'cancelled');
create type public.booking_status as enum ('pending', 'confirmed', 'cancelled', 'completed');
create type public.payment_status as enum ('pending', 'paid', 'failed', 'refunded');

-- ==============================================================================
-- 1. PROFILES (Extends Supabase auth.users)
-- ==============================================================================
create table public.profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    email text not null,
    full_name text not null,
    phone text,
    role public.user_role not null default 'passenger',
    avatar_url text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- ==============================================================================
-- 2. BUSES
-- ==============================================================================
create table public.buses (
    id uuid primary key default gen_random_uuid(),
    bus_number text not null unique,
    bus_name text not null,
    bus_type public.bus_type not null default 'standard',
    total_capacity integer not null check (total_capacity > 0),
    amenities text[] default '{}',
    operator_id uuid references public.profiles(id) on delete set null,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- ==============================================================================
-- 3. ROUTES
-- ==============================================================================
create table public.routes (
    id uuid primary key default gen_random_uuid(),
    route_code text not null unique,
    source_city text not null,
    destination_city text not null,
    distance_km numeric(6, 2) not null check (distance_km > 0),
    estimated_duration_minutes integer not null check (estimated_duration_minutes > 0),
    stops jsonb not null default '[]'::jsonb,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- ==============================================================================
-- 4. SEATS
-- ==============================================================================
create table public.seats (
    id uuid primary key default gen_random_uuid(),
    bus_id uuid not null references public.buses(id) on delete cascade,
    seat_number text not null,
    deck text not null default 'lower' check (deck in ('lower', 'upper')),
    seat_type public.seat_type not null default 'window',
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    constraint unique_bus_seat unique (bus_id, seat_number)
);

-- ==============================================================================
-- 5. TRIPS (Schedules)
-- ==============================================================================
create table public.trips (
    id uuid primary key default gen_random_uuid(),
    trip_code text not null unique,
    bus_id uuid not null references public.buses(id) on delete restrict,
    route_id uuid not null references public.routes(id) on delete restrict,
    driver_id uuid references public.profiles(id) on delete set null,
    departure_time timestamptz not null,
    arrival_time timestamptz not null,
    base_fare numeric(10, 2) not null check (base_fare >= 0),
    status public.trip_status not null default 'scheduled',
    cancellation_reason text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint valid_trip_times check (arrival_time > departure_time)
);

-- ==============================================================================
-- 6. BOOKINGS
-- ==============================================================================
create table public.bookings (
    id uuid primary key default gen_random_uuid(),
    booking_reference text not null unique,
    user_id uuid not null references public.profiles(id) on delete restrict,
    trip_id uuid not null references public.trips(id) on delete restrict,
    total_amount numeric(10, 2) not null check (total_amount >= 0),
    booking_status public.booking_status not null default 'pending',
    payment_status public.payment_status not null default 'pending',
    payment_id text,
    booked_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- ==============================================================================
-- 7. TICKETS (Individual passenger tickets in a booking)
-- ==============================================================================
create table public.tickets (
    id uuid primary key default gen_random_uuid(),
    ticket_number text not null unique,
    booking_id uuid not null references public.bookings(id) on delete cascade,
    trip_id uuid not null references public.trips(id) on delete restrict,
    seat_id uuid not null references public.seats(id) on delete restrict,
    passenger_name text not null,
    passenger_age integer not null check (passenger_age between 1 and 120),
    passenger_gender text not null check (passenger_gender in ('male', 'female', 'other')),
    fare numeric(10, 2) not null check (fare >= 0),
    created_at timestamptz not null default now(),
    -- Enforce single active booking per seat per trip
    constraint unique_trip_seat unique (trip_id, seat_id)
);

-- ==============================================================================
-- 8. BUS LOCATIONS (Real-time GPS Tracking)
-- ==============================================================================
create table public.bus_locations (
    id bigserial primary key,
    bus_id uuid not null references public.buses(id) on delete cascade,
    trip_id uuid references public.trips(id) on delete set null,
    latitude double precision not null check (latitude between -90 and 90),
    longitude double precision not null check (longitude between -180 and 180),
    speed_kmh numeric(5, 2) default 0 check (speed_kmh >= 0),
    heading numeric(5, 2),
    recorded_at timestamptz not null default now()
);

-- ==============================================================================
-- INDEXES FOR PERFORMANCE
-- ==============================================================================
create index idx_trips_route on public.trips(route_id);
create index idx_trips_bus on public.trips(bus_id);
create index idx_trips_departure on public.trips(departure_time);
create index idx_bookings_user on public.bookings(user_id);
create index idx_bookings_trip on public.bookings(trip_id);
create index idx_tickets_booking on public.tickets(booking_id);
create index idx_tickets_trip_seat on public.tickets(trip_id, seat_id);
create index idx_bus_locations_bus on public.bus_locations(bus_id, recorded_at desc);
create index idx_bus_locations_trip on public.bus_locations(trip_id, recorded_at desc);

-- ==============================================================================
-- FUNCTIONS AND TRIGGERS
-- ==============================================================================

-- Trigger to maintain updated_at column
create or replace function public.update_updated_at_column()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger update_profiles_modtime before update on public.profiles
for each row execute procedure public.update_updated_at_column();

create trigger update_buses_modtime before update on public.buses
for each row execute procedure public.update_updated_at_column();

create trigger update_routes_modtime before update on public.routes
for each row execute procedure public.update_updated_at_column();

create trigger update_trips_modtime before update on public.trips
for each row execute procedure public.update_updated_at_column();

create trigger update_bookings_modtime before update on public.bookings
for each row execute procedure public.update_updated_at_column();

-- Function to handle new user profile auto-creation on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
    insert into public.profiles (id, email, full_name, phone, role)
    values (
        new.id,
        new.email,
        coalesce(new.raw_user_meta_data->>'full_name', 'Passenger'),
        new.raw_user_meta_data->>'phone',
        coalesce((new.raw_user_meta_data->>'role')::public.user_role, 'passenger'::public.user_role)
    );
    return new;
end;
$$ language plpgsql security definer;

-- Trigger for auth.users
create or replace trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();

-- Helper function to generate unique booking reference (e.g. SS-2026-X8B9)
create or replace function public.generate_booking_reference()
returns text as $$
declare
    chars text[] := '{0,1,2,3,4,5,6,7,8,9,A,B,C,D,E,F,G,H,J,K,L,M,N,P,Q,R,S,T,U,V,W,X,Y,Z}';
    result text := 'SS-' || to_char(now(), 'YYMM') || '-';
    i integer;
begin
    for i in 1..6 loop
        result := result || chars[1 + floor(random() * array_length(chars, 1))::int];
    end loop;
    return result;
end;
$$ language plpgsql;

-- View for available trip seats
create or replace view public.view_available_seats as
select 
    t.id as trip_id,
    t.trip_code,
    b.id as bus_id,
    b.bus_number,
    b.bus_name,
    s.id as seat_id,
    s.seat_number,
    s.deck,
    s.seat_type,
    case when tk.id is not null then false else true end as is_available
from public.trips t
join public.buses b on t.bus_id = b.id
join public.seats s on s.bus_id = b.id
left join public.tickets tk on tk.trip_id = t.id and tk.seat_id = s.id;

-- ==============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ==============================================================================
alter table public.profiles enable row level security;
alter table public.buses enable row level security;
alter table public.routes enable row level security;
alter table public.seats enable row level security;
alter table public.trips enable row level security;
alter table public.bookings enable row level security;
alter table public.tickets enable row level security;
alter table public.bus_locations enable row level security;

-- Profiles: users can read all profiles (or their own), update their own
create policy "Users can read profiles" on public.profiles
    for select using (true);

create policy "Users can update own profile" on public.profiles
    for update using (auth.uid() = id);

-- Buses & Routes: anyone can view active buses and routes
create policy "Anyone can view active buses" on public.buses
    for select using (is_active = true);

create policy "Operators and Admins can manage buses" on public.buses
    for all using (
        exists (
            select 1 from public.profiles
            where id = auth.uid() and role in ('admin', 'operator')
        )
    );

create policy "Anyone can view active routes" on public.routes
    for select using (is_active = true);

create policy "Admins can manage routes" on public.routes
    for all using (
        exists (
            select 1 from public.profiles
            where id = auth.uid() and role = 'admin'
        )
    );

-- Seats: anyone can view seats
create policy "Anyone can view seats" on public.seats
    for select using (is_active = true);

-- Trips: anyone can view scheduled trips
create policy "Anyone can view trips" on public.trips
    for select using (status != 'cancelled');

create policy "Operators and Admins can manage trips" on public.trips
    for all using (
        exists (
            select 1 from public.profiles
            where id = auth.uid() and role in ('admin', 'operator')
        )
    );

-- Bookings: Passengers see their own bookings; Admins & Operators see all
create policy "Users can read own bookings" on public.bookings
    for select using (
        auth.uid() = user_id or exists (
            select 1 from public.profiles
            where id = auth.uid() and role in ('admin', 'operator')
        )
    );

create policy "Authenticated users can create bookings" on public.bookings
    for insert with check (auth.uid() = user_id);

create policy "Users can update own bookings" on public.bookings
    for update using (
        auth.uid() = user_id or exists (
            select 1 from public.profiles
            where id = auth.uid() and role = 'admin'
        )
    );

-- Tickets: read if you own the booking or are admin/operator
create policy "Users can view their tickets" on public.tickets
    for select using (
        exists (
            select 1 from public.bookings
            where bookings.id = tickets.booking_id and (
                bookings.user_id = auth.uid() or exists (
                    select 1 from public.profiles
                    where id = auth.uid() and role in ('admin', 'operator')
                )
            )
        )
    );

create policy "Users can insert tickets for own booking" on public.tickets
    for insert with check (
        exists (
            select 1 from public.bookings
            where bookings.id = tickets.booking_id and bookings.user_id = auth.uid()
        )
    );

-- Bus Locations: live tracking viewable by everyone
create policy "Anyone can read bus locations" on public.bus_locations
    for select using (true);

create policy "Drivers and Operators can insert bus locations" on public.bus_locations
    for insert with check (
        exists (
            select 1 from public.profiles
            where id = auth.uid() and role in ('driver', 'operator', 'admin')
        )
    );

-- Enable Supabase Realtime for live updates
alter publication supabase_realtime add table public.bus_locations;
alter publication supabase_realtime add table public.trips;
alter publication supabase_realtime add table public.bookings;

-- ==============================================================================
-- SafarSaathi (सफर साथी) - Seed Data
-- ==============================================================================

-- 1. Insert Routes
insert into public.routes (id, route_code, source_city, destination_city, distance_km, estimated_duration_minutes, stops)
values 
  (
    '11111111-1111-1111-1111-111111111111',
    'RT-DEL-JAI-01',
    'New Delhi',
    'Jaipur',
    280.00,
    330,
    '[
      {"name": "ISBT Kashmiri Gate, Delhi", "sequence": 1, "offset_minutes": 0},
      {"name": "Dhaula Kuan, Delhi", "sequence": 2, "offset_minutes": 35},
      {"name": "IFFCO Chowk, Gurgaon", "sequence": 3, "offset_minutes": 60},
      {"name": "Neemrana Midway", "sequence": 4, "offset_minutes": 150},
      {"name": "Sindhi Camp, Jaipur", "sequence": 5, "offset_minutes": 330}
    ]'::jsonb
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'RT-DDN-DEL-02',
    'Dehradun',
    'New Delhi',
    250.00,
    300,
    '[
      {"name": "ISBT Dehradun", "sequence": 1, "offset_minutes": 0},
      {"name": "Roorkee", "sequence": 2, "offset_minutes": 70},
      {"name": "Muzaffarnagar", "sequence": 3, "offset_minutes": 130},
      {"name": "Meerut Bypass", "sequence": 4, "offset_minutes": 200},
      {"name": "Anand Vihar ISBT, Delhi", "sequence": 5, "offset_minutes": 300}
    ]'::jsonb
  ),
  (
    '33333333-3333-3333-3333-333333333333',
    'RT-BOM-PUN-03',
    'Mumbai',
    'Pune',
    150.00,
    180,
    '[
      {"name": "Borivali West, Mumbai", "sequence": 1, "offset_minutes": 0},
      {"name": "Dadar TT Circle, Mumbai", "sequence": 2, "offset_minutes": 45},
      {"name": "Vashi Highway, Navi Mumbai", "sequence": 3, "offset_minutes": 75},
      {"name": "Wakad, Pune", "sequence": 4, "offset_minutes": 150},
      {"name": "Swargate, Pune", "sequence": 5, "offset_minutes": 180}
    ]'::jsonb
  );

-- 2. Insert Buses
insert into public.buses (id, bus_number, bus_name, bus_type, total_capacity, amenities, is_active)
values
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'DL 01 AA 1001',
    'SafarSaathi Gold Volvo Multi-Axle',
    'volvo_multi_axle',
    30,
    array['AC', 'WiFi', 'Charging Point', 'Blanket', 'Water Bottle', 'Live Tracking', 'Emergency Exit'],
    true
  ),
  (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'UK 07 TB 4004',
    'SafarSaathi Royal Sleeper AC',
    'ac_sleeper',
    30,
    array['AC', 'Reading Light', 'Charging Point', 'Pillow', 'Water Bottle', 'CCTV'],
    true
  ),
  (
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    'MH 12 EV 9999',
    'SafarSaathi E-Transit Zero Emission',
    'electric',
    30,
    array['AC', 'USB Charging', 'Ergonomic Seats', 'WiFi', 'Air Suspension'],
    true
  );

-- 3. Populate Seats for Bus 1 (Volvo Multi-Axle, 30 seats: 15 Lower, 15 Upper)
insert into public.seats (bus_id, seat_number, deck, seat_type)
select 
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
  'L' || i,
  'lower',
  case when i % 2 = 1 then 'window'::public.seat_type else 'aisle'::public.seat_type end
from generate_series(1, 15) as i;

insert into public.seats (bus_id, seat_number, deck, seat_type)
select 
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
  'U' || i,
  'upper',
  case when i % 2 = 1 then 'sleeper_lower'::public.seat_type else 'sleeper_upper'::public.seat_type end
from generate_series(1, 15) as i;

-- Seats for Bus 2
insert into public.seats (bus_id, seat_number, deck, seat_type)
select 
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
  'SL-' || i,
  'lower',
  'sleeper_lower'::public.seat_type
from generate_series(1, 15) as i;

insert into public.seats (bus_id, seat_number, deck, seat_type)
select 
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
  'SU-' || i,
  'upper',
  'sleeper_upper'::public.seat_type
from generate_series(1, 15) as i;

-- Seats for Bus 3
insert into public.seats (bus_id, seat_number, deck, seat_type)
select 
  'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid,
  'E' || i,
  'lower',
  case when i % 3 = 1 then 'window'::public.seat_type else 'aisle'::public.seat_type end
from generate_series(1, 30) as i;

-- 4. Insert Trips
insert into public.trips (id, trip_code, bus_id, route_id, departure_time, arrival_time, base_fare, status)
values
  (
    '99999999-9999-9999-9999-999999999999',
    'TRIP-DEL-JAI-MORNING',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '11111111-1111-1111-1111-111111111111',
    now() + interval '4 hours',
    now() + interval '9 hours 30 minutes',
    850.00,
    'scheduled'
  ),
  (
    '88888888-8888-8888-8888-888888888888',
    'TRIP-DDN-DEL-NIGHT',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    '22222222-2222-2222-2222-222222222222',
    now() + interval '10 hours',
    now() + interval '15 hours',
    1100.00,
    'scheduled'
  ),
  (
    '77777777-7777-7777-7777-777777777777',
    'TRIP-BOM-PUN-EXPRESS',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
    '33333333-3333-3333-3333-333333333333',
    now() + interval '1 hour',
    now() + interval '4 hours',
    450.00,
    'boarding'
  );

-- 5. Insert Live Location Breadcrumbs
insert into public.bus_locations (bus_id, trip_id, latitude, longitude, speed_kmh, heading, recorded_at)
values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '77777777-7777-7777-7777-777777777777', 19.0760, 72.8777, 45.5, 120.0, now() - interval '20 minutes'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '77777777-7777-7777-7777-777777777777', 19.0330, 73.0297, 65.0, 115.0, now() - interval '10 minutes'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '77777777-7777-7777-7777-777777777777', 18.9894, 73.1175, 78.2, 110.0, now());

import type { ActiveTrip, Bus, Route, Stop } from '../types';

// MOCK DATA. Coordinates are approximate Dehradun waypoints joined by straight lines —
// they are NOT road-snapped. Replace with real route polylines from Siddhant's `routes` table.

export const CAMPUS: [number, number] = [77.9945, 30.2686];

export const ROUTES: Route[] = [
  {
    id: 'r-rajpur',
    name: 'Rajpur Road – Clock Tower',
    is_active: true,
    color: '#2563eb',
    polyline: [
      [78.065, 30.355], [78.056, 30.339], [78.0418, 30.3245], [78.033, 30.317],
      [78.013, 30.299], [77.9986, 30.2877], [77.996, 30.278], CAMPUS,
    ],
  },
  {
    id: 'r-premnagar',
    name: 'Prem Nagar – Ballupur',
    is_active: true,
    color: '#9333ea',
    polyline: [
      [77.955, 30.333], [77.975, 30.327], [78.0, 30.323], [78.015, 30.319],
      [78.005, 30.3], [77.9986, 30.2877], CAMPUS,
    ],
  },
  {
    id: 'r-raipur',
    name: 'Raipur – Dharampur',
    is_active: true,
    color: '#0891b2',
    polyline: [
      [78.089, 30.311], [78.064, 30.302], [78.044, 30.295], [78.03, 30.28],
      [78.015, 30.272], CAMPUS,
    ],
  },
];

const stop = (id: string, route_id: string, stop_name: string, location: [number, number]): Stop => ({
  id, route_id, stop_name, location, geofence_radius_meters: 80,
});

export const STOPS: Stop[] = [
  stop('s-rajpur', 'r-rajpur', 'Rajpur Road', [78.065, 30.355]),
  stop('s-clock', 'r-rajpur', 'Clock Tower', [78.0418, 30.3245]),
  stop('s-prince', 'r-rajpur', 'Prince Chowk', [78.033, 30.317]),
  stop('s-isbt-a', 'r-rajpur', 'ISBT', [77.9986, 30.2877]),
  stop('s-geu-a', 'r-rajpur', 'Graphic Era Campus', CAMPUS),
  stop('s-prem', 'r-premnagar', 'Prem Nagar', [77.955, 30.333]),
  stop('s-ballupur', 'r-premnagar', 'Ballupur Chowk', [78.0, 30.323]),
  stop('s-isbt-b', 'r-premnagar', 'ISBT', [77.9986, 30.2877]),
  stop('s-geu-b', 'r-premnagar', 'Graphic Era Campus', CAMPUS),
  stop('s-raipur', 'r-raipur', 'Raipur', [78.089, 30.311]),
  stop('s-dharampur', 'r-raipur', 'Dharampur', [78.044, 30.295]),
  stop('s-mothro', 'r-raipur', 'Mothrowala', [78.015, 30.272]),
  stop('s-geu-c', 'r-raipur', 'Graphic Era Campus', CAMPUS),
];

export const BUSES: Bus[] = [
  { id: 'B-401', fleet_number: '401', registration_number: 'UK07 PA 4401', max_capacity: 52, status: 'active' },
  { id: 'B-402', fleet_number: '402', registration_number: 'UK07 PA 4402', max_capacity: 52, status: 'active' },
  { id: 'B-403', fleet_number: '403', registration_number: 'UK07 PA 4403', max_capacity: 40, status: 'active' },
  { id: 'B-404', fleet_number: '404', registration_number: 'UK07 PA 4404', max_capacity: 52, status: 'active' },
  { id: 'B-405', fleet_number: '405', registration_number: 'UK07 PA 4405', max_capacity: 40, status: 'active' },
  { id: 'B-406', fleet_number: '406', registration_number: 'UK07 PA 4406', max_capacity: 52, status: 'maintenance' },
];

const today = (h: number, m: number) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

export const TRIPS: ActiveTrip[] = [
  { id: 't-401', bus_id: 'B-401', route_id: 'r-rajpur', start_time: today(16, 0), end_time: null, is_last_bus: false },
  { id: 't-402', bus_id: 'B-402', route_id: 'r-rajpur', start_time: today(17, 15), end_time: null, is_last_bus: true },
  { id: 't-403', bus_id: 'B-403', route_id: 'r-premnagar', start_time: today(16, 0), end_time: null, is_last_bus: false },
  { id: 't-404', bus_id: 'B-404', route_id: 'r-premnagar', start_time: today(17, 15), end_time: null, is_last_bus: true },
  { id: 't-405', bus_id: 'B-405', route_id: 'r-raipur', start_time: today(16, 30), end_time: null, is_last_bus: true },
];

export const STUDENT_NAMES = [
  'Aarav', 'Diya', 'Kabir', 'Ananya', 'Ishaan', 'Meera', 'Arjun', 'Sanya', 'Rohan', 'Kavya',
  'Vihaan', 'Aisha', 'Reyansh', 'Tara', 'Dev', 'Nisha', 'Aditya', 'Pooja', 'Yash', 'Riya',
];

import { SafarSaathiRepository } from '../repositories/index.js';

/**
 * SafarSaathi Demo Example
 * Demonstrates bus discovery, seat checking, booking flow, and GPS tracking.
 */
async function runDemo() {
  console.log('🚍 Initializing SafarSaathi Supabase Repository...\n');

  const repo = new SafarSaathiRepository();

  console.log('1. Searching for trips between Delhi and Jaipur...');
  try {
    const trips = await repo.trips.searchTrips({
      sourceCity: 'Delhi',
      destinationCity: 'Jaipur',
    });

    console.log(`Found ${trips.length} trip(s):`);
    trips.forEach((t: any) => {
      console.log(`  - [${t.trip_code}] Bus: ${t.buses?.bus_name} (Fare: ₹${t.base_fare})`);
      console.log(`    Departure: ${t.departure_time} -> Arrival: ${t.arrival_time}`);
    });

    if (trips.length > 0) {
      const selectedTrip = trips[0];
      console.log(`\n2. Fetching available seats for Trip: ${selectedTrip.trip_code}...`);
      const seats = await repo.trips.getAvailableSeats(selectedTrip.id);
      const availableSeats = seats.filter((s) => s.is_available);
      console.log(`Total seats: ${seats.length}, Available: ${availableSeats.length}`);
      console.log(`Available seat numbers:`, availableSeats.map((s) => s.seat_number).slice(0, 10).join(', ') + '...');
    }

    console.log('\n3. Checking Live Bus Location...');
    const buses = await repo.buses.getAllActiveBuses();
    if (buses.length > 0) {
      const bus = buses[0];
      const location = await repo.locations.getLatestLocation(bus.id);
      if (location) {
        console.log(`Bus: ${bus.bus_name} (${bus.bus_number})`);
        console.log(`  GPS Position: Lat ${location.latitude}, Lng ${location.longitude}`);
        console.log(`  Speed: ${location.speed_kmh} km/h | Recorded At: ${location.recorded_at}`);
      } else {
        console.log(`No active GPS pings recorded yet for bus ${bus.bus_name}`);
      }
    }
  } catch (err: any) {
    console.error('Error during demo run:', err.message);
    console.log('\nTip: Make sure your local Supabase instance is running with `npm run supabase:start`');
  }
}

runDemo();

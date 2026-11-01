import { BaseRepository } from './base.repository.js';
import { Database, PaymentStatus, BookingStatus } from '../types/database.types.js';

type BookingRow = Database['public']['Tables']['bookings']['Row'];

export interface PassengerTicketInput {
  seatId: string;
  passengerName: string;
  passengerAge: number;
  passengerGender: string;
  fare: number;
}

export interface CreateBookingParams {
  userId: string;
  tripId: string;
  passengers: PassengerTicketInput[];
}

export class BookingRepository extends BaseRepository {
  /**
   * Create a booking along with individual tickets
   */
  async createBooking(params: CreateBookingParams): Promise<BookingRow> {
    const totalAmount = params.passengers.reduce((sum, p) => sum + p.fare, 0);

    // Generate unique booking reference
    const randomSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
    const bookingRef = `SS-${new Date().toISOString().slice(2, 4)}${new Date().getMonth() + 1}-${randomSuffix}`;

    // 1. Create booking record
    const { data: booking, error: bookingErr } = await this.client
      .from('bookings')
      .insert({
        booking_reference: bookingRef,
        user_id: params.userId,
        trip_id: params.tripId,
        total_amount: totalAmount,
        booking_status: 'pending',
        payment_status: 'pending',
      })
      .select()
      .single();

    if (bookingErr) throw bookingErr;

    // 2. Insert individual tickets
    const tickets = params.passengers.map((p, idx) => ({
      ticket_number: `${bookingRef}-T${idx + 1}`,
      booking_id: booking.id,
      trip_id: params.tripId,
      seat_id: p.seatId,
      passenger_name: p.passengerName,
      passenger_age: p.passengerAge,
      passenger_gender: p.passengerGender,
      fare: p.fare,
    }));

    const { error: ticketErr } = await this.client.from('tickets').insert(tickets);

    if (ticketErr) {
      // Rollback booking if tickets insertion fails (e.g., seat already taken)
      await this.client.from('bookings').delete().eq('id', booking.id);
      throw new Error(`Failed to reserve seats: ${ticketErr.message}`);
    }

    return booking;
  }

  /**
   * Get booking details with tickets and trip info
   */
  async getBookingByReference(reference: string) {
    const { data, error } = await this.client
      .from('bookings')
      .select(`
        *,
        tickets (
          id,
          ticket_number,
          passenger_name,
          passenger_age,
          passenger_gender,
          fare,
          seats (
            seat_number,
            deck,
            seat_type
          )
        ),
        trips (
          trip_code,
          departure_time,
          arrival_time,
          buses (bus_name, bus_number),
          routes (source_city, destination_city)
        )
      `)
      .eq('booking_reference', reference)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }
    return data;
  }

  /**
   * Get all bookings for a user
   */
  async getUserBookings(userId: string) {
    const { data, error } = await this.client
      .from('bookings')
      .select(`
        *,
        tickets (*),
        trips (
          trip_code,
          departure_time,
          arrival_time,
          buses (bus_name, bus_number),
          routes (source_city, destination_city)
        )
      `)
      .eq('user_id', userId)
      .order('booked_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Update payment status
   */
  async updatePaymentStatus(
    bookingId: string,
    paymentStatus: PaymentStatus,
    paymentId?: string
  ): Promise<BookingRow> {
    const status: BookingStatus = paymentStatus === 'paid' ? 'confirmed' : 'pending';

    const { data, error } = await this.client
      .from('bookings')
      .update({
        payment_status: paymentStatus,
        booking_status: status,
        payment_id: paymentId ?? null,
      })
      .eq('id', bookingId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Cancel booking
   */
  async cancelBooking(bookingId: string): Promise<BookingRow> {
    const { data, error } = await this.client
      .from('bookings')
      .update({
        booking_status: 'cancelled',
      })
      .eq('id', bookingId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }
}

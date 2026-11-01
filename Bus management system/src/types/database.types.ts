export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type UserRole = 'admin' | 'operator' | 'driver' | 'conductor' | 'passenger';
export type BusType = 'standard' | 'deluxe' | 'ac_sleeper' | 'non_ac_sleeper' | 'volvo_multi_axle' | 'electric';
export type SeatType = 'window' | 'aisle' | 'sleeper_lower' | 'sleeper_upper';
export type TripStatus = 'scheduled' | 'boarding' | 'in_transit' | 'delayed' | 'completed' | 'cancelled';
export type BookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed';
export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string;
          phone: string | null;
          role: UserRole;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name: string;
          phone?: string | null;
          role?: UserRole;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string;
          phone?: string | null;
          role?: UserRole;
          avatar_url?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          }
        ];
      };
      buses: {
        Row: {
          id: string;
          bus_number: string;
          bus_name: string;
          bus_type: BusType;
          total_capacity: number;
          amenities: string[];
          operator_id: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          bus_number: string;
          bus_name: string;
          bus_type?: BusType;
          total_capacity: number;
          amenities?: string[];
          operator_id?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          bus_number?: string;
          bus_name?: string;
          bus_type?: BusType;
          total_capacity?: number;
          amenities?: string[];
          operator_id?: string | null;
          is_active?: boolean;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "buses_operator_id_fkey";
            columns: ["operator_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      routes: {
        Row: {
          id: string;
          route_code: string;
          source_city: string;
          destination_city: string;
          distance_km: number;
          estimated_duration_minutes: number;
          stops: Json;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          route_code: string;
          source_city: string;
          destination_city: string;
          distance_km: number;
          estimated_duration_minutes: number;
          stops?: Json;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          route_code?: string;
          source_city?: string;
          destination_city?: string;
          distance_km?: number;
          estimated_duration_minutes?: number;
          stops?: Json;
          is_active?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      seats: {
        Row: {
          id: string;
          bus_id: string;
          seat_number: string;
          deck: 'lower' | 'upper';
          seat_type: SeatType;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          bus_id: string;
          seat_number: string;
          deck?: 'lower' | 'upper';
          seat_type?: SeatType;
          is_active?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          bus_id?: string;
          seat_number?: string;
          deck?: 'lower' | 'upper';
          seat_type?: SeatType;
          is_active?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "seats_bus_id_fkey";
            columns: ["bus_id"];
            isOneToOne: false;
            referencedRelation: "buses";
            referencedColumns: ["id"];
          }
        ];
      };
      trips: {
        Row: {
          id: string;
          trip_code: string;
          bus_id: string;
          route_id: string;
          driver_id: string | null;
          departure_time: string;
          arrival_time: string;
          base_fare: number;
          status: TripStatus;
          cancellation_reason: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          trip_code: string;
          bus_id: string;
          route_id: string;
          driver_id?: string | null;
          departure_time: string;
          arrival_time: string;
          base_fare: number;
          status?: TripStatus;
          cancellation_reason?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          trip_code?: string;
          bus_id?: string;
          route_id?: string;
          driver_id?: string | null;
          departure_time?: string;
          arrival_time?: string;
          base_fare?: number;
          status?: TripStatus;
          cancellation_reason?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "trips_bus_id_fkey";
            columns: ["bus_id"];
            isOneToOne: false;
            referencedRelation: "buses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "trips_route_id_fkey";
            columns: ["route_id"];
            isOneToOne: false;
            referencedRelation: "routes";
            referencedColumns: ["id"];
          }
        ];
      };
      bookings: {
        Row: {
          id: string;
          booking_reference: string;
          user_id: string;
          trip_id: string;
          total_amount: number;
          booking_status: BookingStatus;
          payment_status: PaymentStatus;
          payment_id: string | null;
          booked_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          booking_reference: string;
          user_id: string;
          trip_id: string;
          total_amount: number;
          booking_status?: BookingStatus;
          payment_status?: PaymentStatus;
          payment_id?: string | null;
          booked_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          booking_reference?: string;
          user_id?: string;
          trip_id?: string;
          total_amount?: number;
          booking_status?: BookingStatus;
          payment_status?: PaymentStatus;
          payment_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "bookings_trip_id_fkey";
            columns: ["trip_id"];
            isOneToOne: false;
            referencedRelation: "trips";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bookings_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      tickets: {
        Row: {
          id: string;
          ticket_number: string;
          booking_id: string;
          trip_id: string;
          seat_id: string;
          passenger_name: string;
          passenger_age: number;
          passenger_gender: string;
          fare: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          ticket_number: string;
          booking_id: string;
          trip_id: string;
          seat_id: string;
          passenger_name: string;
          passenger_age: number;
          passenger_gender: string;
          fare: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          ticket_number?: string;
          booking_id?: string;
          trip_id?: string;
          seat_id?: string;
          passenger_name?: string;
          passenger_age?: number;
          passenger_gender?: string;
          fare?: number;
        };
        Relationships: [
          {
            foreignKeyName: "tickets_booking_id_fkey";
            columns: ["booking_id"];
            isOneToOne: false;
            referencedRelation: "bookings";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tickets_seat_id_fkey";
            columns: ["seat_id"];
            isOneToOne: false;
            referencedRelation: "seats";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tickets_trip_id_fkey";
            columns: ["trip_id"];
            isOneToOne: false;
            referencedRelation: "trips";
            referencedColumns: ["id"];
          }
        ];
      };
      bus_locations: {
        Row: {
          id: number;
          bus_id: string;
          trip_id: string | null;
          latitude: number;
          longitude: number;
          speed_kmh: number;
          heading: number | null;
          recorded_at: string;
        };
        Insert: {
          id?: number;
          bus_id: string;
          trip_id?: string | null;
          latitude: number;
          longitude: number;
          speed_kmh?: number;
          heading?: number | null;
          recorded_at?: string;
        };
        Update: {
          id?: number;
          bus_id?: string;
          trip_id?: string | null;
          latitude?: number;
          longitude?: number;
          speed_kmh?: number;
          heading?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "bus_locations_bus_id_fkey";
            columns: ["bus_id"];
            isOneToOne: false;
            referencedRelation: "buses";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "bus_locations_trip_id_fkey";
            columns: ["trip_id"];
            isOneToOne: false;
            referencedRelation: "trips";
            referencedColumns: ["id"];
          }
        ];
      };
    };
    Views: {
      view_available_seats: {
        Row: {
          trip_id: string;
          trip_code: string;
          bus_id: string;
          bus_number: string;
          bus_name: string;
          seat_id: string;
          seat_number: string;
          deck: string;
          seat_type: SeatType;
          is_available: boolean;
        };
        Relationships: [];
      };
    };
    Functions: {
      generate_booking_reference: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
    };
    Enums: {
      user_role: UserRole;
      bus_type: BusType;
      seat_type: SeatType;
      trip_status: TripStatus;
      booking_status: BookingStatus;
      payment_status: PaymentStatus;
    };
    CompositeTypes: Record<string, never>;
  };
}

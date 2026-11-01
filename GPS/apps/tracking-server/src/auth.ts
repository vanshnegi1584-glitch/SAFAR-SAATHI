import type { Db } from './db';

export type Role = 'admin' | 'operator' | 'driver' | 'conductor' | 'passenger' | 'student';

export interface Principal {
  userId: string;
  role: Role;
}

export interface Authenticator {
  /** Resolves a bearer token to a user. Role always comes from public.profiles, never from the token. */
  verify(token: string | null | undefined): Promise<Principal | null>;
}

export class AuthError extends Error {
  constructor(readonly status: 401 | 403, message: string) {
    super(message);
  }
}

async function roleOf(db: Db, userId: string): Promise<Role | null> {
  const { rows } = await db.query<{ role: Role }>('select role from public.profiles where id = $1', [userId]);
  return rows[0]?.role ?? null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates Supabase access tokens by asking Supabase Auth (`GET /auth/v1/user`), which works for both
 * legacy HS256 and asymmetric signing keys. Results are cached briefly to keep reconnect storms cheap.
 */
export class SupabaseAuthenticator implements Authenticator {
  private cache = new Map<string, { principal: Principal; until: number }>();

  constructor(private readonly db: Db, private readonly supabaseUrl: string, private readonly anonKey: string, private readonly ttlMs = 60_000) {}

  async verify(token: string | null | undefined): Promise<Principal | null> {
    if (!token) return null;
    const hit = this.cache.get(token);
    if (hit && hit.until > Date.now()) return hit.principal;
    const res = await fetch(`${this.supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: this.anonKey },
    });
    if (!res.ok) return null;
    const user = (await res.json()) as { id?: string };
    if (!user.id) return null;
    const role = await roleOf(this.db, user.id);
    if (!role) return null;
    const principal = { userId: user.id, role };
    if (this.cache.size > 5000) this.cache.clear();
    this.cache.set(token, { principal, until: Date.now() + this.ttlMs });
    return principal;
  }
}

/** DEV ONLY: `dev:<profile uuid>` → that profile. Enabled by DEV_AUTH=1 and refused in production. */
export class DevAuthenticator implements Authenticator {
  constructor(private readonly db: Db) {}

  async verify(token: string | null | undefined): Promise<Principal | null> {
    const id = token?.startsWith('dev:') ? token.slice(4) : null;
    if (!id || !UUID.test(id)) return null;
    const role = await roleOf(this.db, id);
    return role ? { userId: id, role } : null;
  }
}

export const bearer = (header: string | undefined) => (header?.startsWith('Bearer ') ? header.slice(7) : null);

export const isStaff = (p: Principal) => p.role === 'admin' || p.role === 'operator';

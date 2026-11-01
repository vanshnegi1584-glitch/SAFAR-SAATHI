// Minimal Supabase Auth (GoTrue REST) client: email/password sign-in, refresh, sign-out.
// Avoids pulling supabase-js into both apps just to obtain an access token. Storage is pluggable so the
// web app can use sessionStorage and the phone a secure keychain.

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  /** Epoch seconds. */
  expires_at: number;
  user: { id: string; email?: string };
}

export interface SessionStorage {
  get(): Promise<string | null> | string | null;
  set(value: string): Promise<void> | void;
  clear(): Promise<void> | void;
}

export class SupabaseAuthClient {
  private session: AuthSession | null = null;
  private refreshing: Promise<AuthSession | null> | null = null;

  constructor(private readonly url: string, private readonly anonKey: string, private readonly storage: SessionStorage) {}

  private async call(path: string, body: unknown): Promise<AuthSession> {
    const res = await fetch(`${this.url}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: this.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Partial<AuthSession> & { expires_in?: number; error_description?: string; msg?: string };
    if (!res.ok || !json.access_token) throw new Error(json.error_description ?? json.msg ?? `Sign-in failed (${res.status})`);
    const session: AuthSession = {
      access_token: json.access_token,
      refresh_token: json.refresh_token!,
      expires_at: json.expires_at ?? Math.floor(Date.now() / 1000) + (json.expires_in ?? 3600),
      user: json.user!,
    };
    this.session = session;
    await this.storage.set(JSON.stringify(session));
    return session;
  }

  signIn(email: string, password: string): Promise<AuthSession> {
    return this.call('token?grant_type=password', { email, password });
  }

  async restore(): Promise<AuthSession | null> {
    const raw = await this.storage.get();
    if (!raw) return null;
    try {
      this.session = JSON.parse(raw) as AuthSession;
    } catch {
      await this.storage.clear();
      return null;
    }
    return this.getSession();
  }

  /** Current session, refreshed if it expires within a minute. Null when signed out or refresh fails. */
  async getSession(): Promise<AuthSession | null> {
    const s = this.session;
    if (!s) return null;
    if (s.expires_at - 60 > Date.now() / 1000) return s;
    this.refreshing ??= this.call('token?grant_type=refresh_token', { refresh_token: s.refresh_token })
      .catch(async () => {
        await this.signOut();
        return null;
      })
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async getAccessToken(): Promise<string | null> {
    return (await this.getSession())?.access_token ?? null;
  }

  async signOut(): Promise<void> {
    const token = this.session?.access_token;
    this.session = null;
    await this.storage.clear();
    if (token) {
      await fetch(`${this.url}/auth/v1/logout`, { method: 'POST', headers: { apikey: this.anonKey, Authorization: `Bearer ${token}` } }).catch(() => {});
    }
  }
}

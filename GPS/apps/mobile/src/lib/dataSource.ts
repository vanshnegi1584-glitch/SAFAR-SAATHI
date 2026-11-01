import { LiveTransitSource, MockTransitSource, type TransitDataSource } from '@transitlink/shared';

let instance: TransitDataSource | null = null;

/** One data source per app process. Switch with EXPO_PUBLIC_DATA_SOURCE=mock|live. */
export function getDataSource(): TransitDataSource {
  if (instance) return instance;
  instance =
    process.env.EXPO_PUBLIC_DATA_SOURCE === 'live'
      ? new LiveTransitSource({ apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000' })
      : new MockTransitSource({ autoDispatch: true });
  return instance;
}

export const isMock = () => getDataSource().kind === 'mock';

/** The mock has no auth, so the student is a fixed id; live mode takes it from the auth token. */
export const MOCK_STUDENT_ID = 'me';

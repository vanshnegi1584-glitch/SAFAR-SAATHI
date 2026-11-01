import { LiveTransitSource, MockTransitSource, type TransitDataSource } from '@transitlink/shared';

let instance: TransitDataSource | null = null;

/** One data source per browser tab. Switch with NEXT_PUBLIC_DATA_SOURCE=mock|live. */
export function getDataSource(): TransitDataSource {
  if (instance) return instance;
  instance =
    process.env.NEXT_PUBLIC_DATA_SOURCE === 'live'
      ? new LiveTransitSource({ apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000' })
      : new MockTransitSource();
  return instance;
}

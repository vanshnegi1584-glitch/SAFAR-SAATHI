import { describe, expect, it } from 'vitest';
import { buildComputeRoutesRequest, decodePolyline, parseComputeRoutesResponse } from './googleRoutes';

describe('decodePolyline', () => {
  it("decodes Google's documented example", () => {
    // From the Encoded Polyline Algorithm Format docs: (38.5,-120.2), (40.7,-120.95), (43.252,-126.453)
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts).toEqual([[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]]);
  });
});

describe('computeRoutes mapping', () => {
  const stops: [number, number][] = [[78.06, 30.35], [78.04, 30.32], [77.99, 30.27]];

  it('puts first/last stops as origin/destination and the rest as intermediates', () => {
    const req = buildComputeRoutesRequest(stops);
    expect(req.origin.location.latLng).toEqual({ latitude: 30.35, longitude: 78.06 });
    expect(req.destination.location.latLng).toEqual({ latitude: 30.27, longitude: 77.99 });
    expect(req.intermediates).toHaveLength(1);
  });

  it('snaps stops to leg endpoints and parses duration', () => {
    const ll = (latitude: number, longitude: number) => ({ latLng: { latitude, longitude } });
    const r = parseComputeRoutesResponse({
      routes: [{
        distanceMeters: 12000, duration: '1500s',
        polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC' },
        legs: [
          { startLocation: ll(30.351, 78.061), endLocation: ll(30.321, 78.041) },
          { startLocation: ll(30.321, 78.041), endLocation: ll(30.271, 77.991) },
        ],
      }],
    }, 3);
    expect(r.stopLocations).toEqual([[78.061, 30.351], [78.041, 30.321], [77.991, 30.271]]);
    expect(r.durationSeconds).toBe(1500);
    expect(r.polyline).toHaveLength(2);
  });

  it('rejects an empty response', () => {
    expect(() => parseComputeRoutesResponse({ routes: [] }, 2)).toThrow();
  });
});

/** How a bus is named on maps and lists: by its allotted number ("Bus 18"), not its vehicle registration.
 *  Falls back to the id when the number is unknown, so a bus is never left unlabelled. */
export function busLabel(bus: { fleet_number?: string | null } | null | undefined, fallbackId: string): string {
  return bus?.fleet_number ? `Bus ${bus.fleet_number}` : fallbackId;
}

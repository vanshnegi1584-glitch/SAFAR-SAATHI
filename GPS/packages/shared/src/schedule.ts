import { parseCsv } from './csv';
import type { TripDirection } from './trackingTypes';

// Parses SafarSaathi_Bus_Schedule.csv into buses, routes and stops with stable ids.
// The original cell text is always kept next to the normalised value, nothing is dropped, and every
// oddity is reported as an issue for an admin to review rather than silently "fixed".

export const SCHEDULE_COLUMNS = [
  'S.No.', 'Reg. No.', 'Bus No.', 'Shift Timing', 'Driver Name', 'Contact No.', 'Route', 'Seats',
] as const;
export type ScheduleColumn = (typeof SCHEDULE_COLUMNS)[number];

export interface ScheduleIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  /** 1-based data record number (not file line — Route cells can span lines). Null for file-level issues. */
  record: number | null;
  message: string;
}

/** One entry of the Shift Timing cell, in the order written. */
export interface ShiftEntry {
  index: number;
  raw: string;
  /** 24h 'HH:MM' local time, or null for "No Service". */
  time: string | null;
  no_service: boolean;
}

export interface ScheduleRecord {
  record: number;
  raw: Record<ScheduleColumn, string>;
}

export interface ScheduleBus {
  id: string;
  record: number;
  serial: number | null;
  registration_number: string;
  registration_raw: string;
  fleet_number: string;
  seats: number | null;
  driver_name: string | null;
  /** Personal data — keep server-side, never send to student clients. */
  driver_contact: string | null;
  shift: ShiftEntry[];
  route_id: string;
}

export interface ScheduleStop {
  id: string;
  name: string;
  is_college_endpoint: boolean;
}

export interface ScheduleRoute {
  id: string;
  name: string;
  description_raw: string;
  /** In CSV order, i.e. the TO_COLLEGE direction. May contain repeats (e.g. Garhi Cant twice). */
  stop_ids: string[];
  college_stop_id: string | null;
  bus_ids: string[];
}

export interface ParsedSchedule {
  records: ScheduleRecord[];
  buses: ScheduleBus[];
  routes: ScheduleRoute[];
  stops: ScheduleStop[];
  issues: ScheduleIssue[];
}

export interface ParseScheduleOptions {
  /**
   * Admin-reviewed stop merges, e.g. { 'stop-premnagar': 'stop-prem-nagar' }. Spelling variants are
   * only *suggested* by the parser (`possible_duplicate_stop`); they are merged only via this map.
   */
  stopAliases?: Record<string, string>;
}

/** Collapses all whitespace (including line breaks inside quoted cells) and trims. */
export const cleanText = (s: string) => s.replace(/\s+/g, ' ').trim();

export const normalizeRegistration = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const COLLEGE_RE = /^(geu|gehu)(\s*\/\s*(geu|gehu))?$/i;
export const isCollegeName = (name: string) => COLLEGE_RE.test(cleanText(name));

export function stopIdFor(name: string): string {
  const n = cleanText(name);
  if (isCollegeName(n)) {
    const parts = n.toLowerCase().split('/').map((p) => p.trim());
    return `campus-${parts.join('-')}`;
  }
  return `stop-${slug(n)}`;
}

/** FNV-1a, 32-bit — short, deterministic ids that do not change between imports. */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function routeIdFor(stopIds: string[]): string {
  return `route-${(stopIds[0] ?? 'empty').replace(/^(stop|campus)-/, '')}-${hash32(stopIds.join('>')).slice(0, 6)}`;
}

const SHIFT_TOKEN = /(\d{1,2})\s*[.:]\s*(\d{2})\s*([ap])\.?\s*m\.?|no\s*service/gi;

export function parseShiftTiming(raw: string): { entries: ShiftEntry[]; leftover: string } {
  const entries: ShiftEntry[] = [];
  let leftover = raw;
  for (const m of raw.matchAll(SHIFT_TOKEN)) {
    leftover = leftover.replace(m[0], ' ');
    if (!m[1]) {
      entries.push({ index: entries.length, raw: m[0], time: null, no_service: true });
      continue;
    }
    let h = Number(m[1]);
    const min = Number(m[2]);
    const pm = m[3]!.toLowerCase() === 'p';
    if (h < 1 || h > 12 || min > 59) {
      entries.push({ index: entries.length, raw: m[0], time: null, no_service: false });
      continue;
    }
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
    entries.push({
      index: entries.length, raw: m[0], no_service: false,
      time: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`,
    });
  }
  return { entries, leftover: cleanText(leftover) };
}

/** Edit distance, for flagging likely spelling variants of the same stop. */
function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

const compactStopKey = (name: string) =>
  name.toLowerCase().replace(/chowk/g, '').replace(/[^a-z0-9]/g, '');

/**
 * Likely the same place written differently: identical ignoring spaces/"Chowk" (Prem Nagar/Premnagar),
 * one name extending the other (Fountain Chowk/Fountain Chowk Rispana), or one typo in a long name
 * (Balliwalachowk/Baliwala Chowk). Short names are excluded — Raipur and Rajpur are different places.
 */
function likelySameStop(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 6 && (a.startsWith(b) || b.startsWith(a))) return true;
  return Math.min(a.length, b.length) >= 7 && levenshtein(a, b) <= 1;
}

export function parseSchedule(csvText: string, opts: ParseScheduleOptions = {}): ParsedSchedule {
  const aliases = opts.stopAliases ?? {};
  const issues: ScheduleIssue[] = [];
  const issue = (severity: ScheduleIssue['severity'], code: string, record: number | null, message: string) =>
    issues.push({ severity, code, record, message });

  const table = parseCsv(csvText);
  const header = (table[0] ?? []).map(cleanText);
  const colIndex = {} as Record<ScheduleColumn, number>;
  for (const col of SCHEDULE_COLUMNS) {
    const idx = header.findIndex((h) => h.toLowerCase() === col.toLowerCase());
    if (idx < 0) throw new Error(`Schedule CSV is missing the "${col}" column (found: ${header.join(', ')})`);
    colIndex[col] = idx;
  }
  const extra = header.filter((h) => !SCHEDULE_COLUMNS.some((c) => c.toLowerCase() === h.toLowerCase()));
  if (extra.length) issue('info', 'extra_columns', null, `Ignored extra columns: ${extra.join(', ')}`);

  const records: ScheduleRecord[] = [];
  const buses: ScheduleBus[] = [];
  const routes = new Map<string, ScheduleRoute>();
  const stops = new Map<string, ScheduleStop>();
  const byRegistration = new Map<string, ScheduleBus>();
  const byFleetNo = new Map<string, ScheduleBus>();
  const driverContacts = new Map<string, Set<string>>();

  table.slice(1).forEach((cells, i) => {
    const record = i + 1;
    const raw = {} as Record<ScheduleColumn, string>;
    for (const col of SCHEDULE_COLUMNS) raw[col] = cells[colIndex[col]] ?? '';
    records.push({ record, raw });
    if (cells.length !== header.length) {
      issue('warning', 'column_count', record, `Expected ${header.length} cells, found ${cells.length}`);
    }

    const serialText = cleanText(raw['S.No.']);
    const serial = /^\d+$/.test(serialText) ? Number(serialText) : null;
    if (serial === null) issue('warning', 'bad_serial', record, `S.No. "${serialText}" is not a number`);

    // --- registration / stable bus id
    const registration = normalizeRegistration(raw['Reg. No.']);
    if (!registration) issue('error', 'missing_registration', record, 'Reg. No. is empty');
    else if (!/^(UK|UA)\d{2}[A-Z]{1,3}\d{3,4}$/.test(registration)) {
      issue('warning', 'unusual_registration', record, `Reg. No. "${cleanText(raw['Reg. No.'])}" does not look like a UK/UA registration`);
    }
    let busId = registration ? `bus-${registration.toLowerCase()}` : `bus-record-${record}`;
    const dup = registration ? byRegistration.get(registration) : undefined;
    if (dup) {
      busId = `${busId}-r${record}`;
      issue('error', 'duplicate_registration', record, `Reg. No. ${registration} also appears in record ${dup.record}; kept both as ${dup.id} and ${busId} — please resolve`);
    }

    const fleetNumber = cleanText(raw['Bus No.']);
    if (!fleetNumber) issue('warning', 'missing_bus_number', record, 'Bus No. is empty');
    const fleetDup = fleetNumber ? byFleetNo.get(fleetNumber) : undefined;
    if (fleetDup) issue('warning', 'duplicate_bus_number', record, `Bus No. ${fleetNumber} is also used by record ${fleetDup.record}`);

    // --- shift timing
    const shiftRaw = raw['Shift Timing'];
    const { entries: shift, leftover } = parseShiftTiming(shiftRaw);
    if (shift.length === 0) issue('warning', 'missing_shift', record, `Shift Timing "${cleanText(shiftRaw)}" has no recognisable time`);
    if (leftover) issue('warning', 'unparsed_shift_text', record, `Could not interpret "${leftover}" in Shift Timing`);
    shift.filter((s) => !s.no_service && s.time === null)
      .forEach((s) => issue('warning', 'invalid_time', record, `Invalid time "${s.raw}"`));

    // --- seats
    const seatsText = cleanText(raw.Seats);
    const seats = /^\d+$/.test(seatsText) && Number(seatsText) > 0 ? Number(seatsText) : null;
    if (seats === null) issue('warning', 'bad_seats', record, `Seats "${seatsText}" is not a positive whole number`);

    // --- driver
    const driverName = cleanText(raw['Driver Name']) || null;
    if (!driverName) issue('warning', 'missing_driver', record, 'Driver Name is empty');
    const contact = raw['Contact No.'].replace(/\D/g, '') || null;
    if (!contact) issue('warning', 'missing_contact', record, 'Contact No. is empty');
    else if (contact.length !== 10) issue('warning', 'unusual_contact', record, 'Contact No. is not 10 digits');
    if (driverName && contact) {
      const set = driverContacts.get(driverName.toLowerCase()) ?? new Set();
      set.add(contact);
      driverContacts.set(driverName.toLowerCase(), set);
    }

    // --- route and stops (CSV order = TO_COLLEGE)
    const routeRaw = raw.Route;
    const names = routeRaw.split('-').map(cleanText).filter(Boolean);
    if (routeRaw.split('-').map(cleanText).some((n) => !n)) {
      issue('info', 'empty_route_segment', record, 'Route has an empty segment between dashes (ignored)');
    }
    const stopIds = names.map((name) => {
      const own = stopIdFor(name);
      const id = aliases[own] ?? own;
      if (!stops.has(id)) stops.set(id, { id, name, is_college_endpoint: isCollegeName(name) });
      return id;
    });
    const collegeIdx = stopIds.findIndex((id) => stops.get(id)!.is_college_endpoint);
    let collegeStopId: string | null = null;
    if (stopIds.length < 2) issue('error', 'route_too_short', record, `Route "${cleanText(routeRaw)}" has fewer than two stops`);
    if (collegeIdx < 0) {
      issue('error', 'no_college_endpoint', record, `Route "${cleanText(routeRaw)}" does not end at GEU/GEHU`);
    } else if (collegeIdx !== stopIds.length - 1) {
      issue('warning', 'college_not_last', record, 'GEU/GEHU is not the last stop; direction logic needs review');
    } else {
      collegeStopId = stopIds[collegeIdx]!;
    }
    const seen = new Set<string>();
    for (const id of stopIds) {
      if (seen.has(id)) issue('info', 'repeated_stop', record, `${stops.get(id)!.name} appears more than once on this route`);
      seen.add(id);
    }

    const routeId = routeIdFor(stopIds);
    let route = routes.get(routeId);
    if (!route) {
      route = {
        id: routeId,
        name: `${names[0] ?? '?'} → ${names.at(-1) ?? '?'}`,
        description_raw: cleanText(routeRaw),
        stop_ids: stopIds,
        college_stop_id: collegeStopId,
        bus_ids: [],
      };
      routes.set(routeId, route);
    }
    route.bus_ids.push(busId);

    const bus: ScheduleBus = {
      id: busId, record, serial,
      registration_number: registration,
      registration_raw: raw['Reg. No.'],
      fleet_number: fleetNumber,
      seats, driver_name: driverName, driver_contact: contact,
      shift, route_id: routeId,
    };
    buses.push(bus);
    if (registration && !dup) byRegistration.set(registration, bus);
    if (fleetNumber && !fleetDup) byFleetNo.set(fleetNumber, bus);
  });

  for (const [name, contacts] of driverContacts) {
    if (contacts.size > 1) {
      issue('info', 'shared_driver_name', null, `Driver name "${name}" appears with ${contacts.size} different contact numbers — treated as different people`);
    }
  }

  // Suggest (never apply) merges for likely spelling variants: "Prem Nagar"/"Premnagar", "Kargi"/"Kargi Chowk".
  const list = [...stops.values()].filter((s) => !s.is_college_endpoint);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (likelySameStop(compactStopKey(list[i]!.name), compactStopKey(list[j]!.name))) {
        issue('warning', 'possible_duplicate_stop', null,
          `"${list[i]!.name}" (${list[i]!.id}) and "${list[j]!.name}" (${list[j]!.id}) may be the same stop — add to stop-aliases.json after checking`);
      }
    }
  }

  return { records, buses, routes: [...routes.values()], stops: [...stops.values()], issues };
}

// ---------------------------------------------------------------------------------------------------
// Application departure slots vs. CSV shift timings

export interface DepartureSlot {
  id: string;
  /** Local 'HH:MM' in the configured timezone. */
  time: string;
  direction: TripDirection;
  label: string;
  /**
   * Which Shift Timing entry (0-based) this slot corresponds to, if the CSV covers it. Afternoon
   * departures are not in the CSV, so they are null and always need explicit admin confirmation.
   */
  csv_shift_index: number | null;
}

export interface DepartureConfig {
  timezone: string;
  slots: DepartureSlot[];
}

/** The application-level schedule requested for SafarSaathi. Change here, not in components. */
export const DEFAULT_DEPARTURE_CONFIG: DepartureConfig = {
  timezone: 'Asia/Kolkata',
  slots: [
    { id: 'am-0700', time: '07:00', direction: 'TO_COLLEGE', label: 'Morning pickup 7:00 AM', csv_shift_index: 0 },
    { id: 'am-1100', time: '11:00', direction: 'TO_COLLEGE', label: 'Morning pickup 11:00 AM', csv_shift_index: 1 },
    { id: 'pm-1300', time: '13:00', direction: 'FROM_COLLEGE', label: 'Departure 1:00 PM', csv_shift_index: null },
    { id: 'pm-1600', time: '16:00', direction: 'FROM_COLLEGE', label: 'Departure 4:00 PM', csv_shift_index: null },
    { id: 'pm-1800', time: '18:00', direction: 'FROM_COLLEGE', label: 'Departure 6:00 PM', csv_shift_index: null },
  ],
};

export type SlotMappingStatus =
  | 'matched' // CSV time equals the slot time
  | 'conflict' // CSV gives a different time — admin must decide
  | 'no_service' // CSV says "No Service" for this shift
  | 'unconfirmed' // CSV says nothing about this slot
  | 'confirmed' // admin confirmed the bus runs this slot
  | 'cancelled'; // admin confirmed it does not

export interface SlotMapping {
  bus_id: string;
  slot_id: string;
  status: SlotMappingStatus;
  csv_time: string | null;
  note: string;
}

/** Admin decisions keyed by `${bus_id}|${slot_id}`. */
export type SlotOverrides = Record<string, 'confirmed' | 'cancelled'>;

export function mapDepartureSlots(
  buses: Pick<ScheduleBus, 'id' | 'shift'>[],
  config: DepartureConfig = DEFAULT_DEPARTURE_CONFIG,
  overrides: SlotOverrides = {},
): SlotMapping[] {
  const out: SlotMapping[] = [];
  for (const bus of buses) {
    for (const slot of config.slots) {
      const override = overrides[`${bus.id}|${slot.id}`];
      const entry = slot.csv_shift_index === null ? undefined : bus.shift[slot.csv_shift_index];
      const csvTime = entry?.time ?? null;
      let status: SlotMappingStatus;
      let note: string;
      if (!entry) {
        status = 'unconfirmed';
        note = slot.csv_shift_index === null ? 'Not covered by the CSV schedule' : 'CSV has no entry for this shift';
      } else if (entry.no_service) {
        status = 'no_service';
        note = 'CSV: No Service';
      } else if (csvTime === slot.time) {
        status = 'matched';
        note = 'CSV time matches';
      } else {
        status = 'conflict';
        note = `CSV says ${csvTime ?? entry.raw}, slot is ${slot.time}`;
      }
      if (override) {
        note = `${note}; admin ${override}`;
        status = override;
      }
      out.push({ bus_id: bus.id, slot_id: slot.id, status, csv_time: csvTime, note });
    }
  }
  return out;
}

/** Only these produce scheduled trips; conflicts and unconfirmed slots never do. */
export const slotRuns = (s: SlotMappingStatus) => s === 'matched' || s === 'confirmed';

/** 'YYYY-MM-DD' of `at` in `timeZone`. */
export function localDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** UTC instant of a local wall-clock time in `timeZone` (handles any fixed or DST offset). */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asLocal = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (asLocal - guess));
}

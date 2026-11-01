// Usage: npm run import-schedule -w @transitlink/tracking-server -- <path/to/schedule.csv> [--aliases path/to/stop-aliases.json] [--dry-run]
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseSchedule } from '@transitlink/shared';
import { createPgDb } from '../db';
import { importSchedule } from '../importer';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--aliases');
const aliasesPath = args.includes('--aliases') ? args[args.indexOf('--aliases') + 1] : undefined;
const dryRun = args.includes('--dry-run');
if (!file || !existsSync(file)) {
  console.error('Usage: import-schedule <schedule.csv> [--aliases stop-aliases.json] [--dry-run]');
  process.exit(1);
}
const csv = readFileSync(file, 'utf8');
const stopAliases = aliasesPath ? (JSON.parse(readFileSync(aliasesPath, 'utf8')) as Record<string, string>) : undefined;

if (dryRun || !process.env.DATABASE_URL) {
  if (!dryRun) console.warn('DATABASE_URL not set — showing a dry run.');
  const s = parseSchedule(csv, { stopAliases });
  console.log(`${s.records.length} records → ${s.buses.length} buses, ${s.routes.length} routes, ${s.stops.length} stops`);
  for (const i of s.issues) console.log(`  [${i.severity}] ${i.record ? `record ${i.record}: ` : ''}${i.message}`);
  process.exit(s.issues.some((i) => i.severity === 'error') ? 2 : 0);
}

const db = createPgDb(process.env.DATABASE_URL);
try {
  const r = await importSchedule(db, csv, { fileName: basename(file), stopAliases });
  console.log(`Import ${r.import_id}: ${r.buses_upserted} buses, ${r.routes_active} routes, ${r.stops} stops`);
  if (r.buses_skipped.length) console.log('Skipped (fix in the CSV):', r.buses_skipped);
  if (r.buses_deactivated || r.routes_deactivated) console.log(`Deactivated: ${r.buses_deactivated} buses, ${r.routes_deactivated} routes no longer in the CSV`);
  for (const i of r.issues) console.log(`  [${i.severity}] ${i.record ? `record ${i.record}: ` : ''}${i.message}`);
} finally {
  await db.end();
}

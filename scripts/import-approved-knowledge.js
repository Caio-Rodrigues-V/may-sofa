import fs from 'node:fs';
import { config, assertIsolatedConfiguration } from '../src/config.js';

assertIsolatedConfiguration();
if (!config.supabaseUrl || !config.supabaseKey) throw new Error('Configure a dedicated Sofas May Supabase before importing.');
const items = JSON.parse(fs.readFileSync(new URL('../data/approved-knowledge.json', import.meta.url), 'utf8'));
const response = await fetch(`${config.supabaseUrl}/rest/v1/${config.tablePrefix}knowledge?on_conflict=topic,title`, {
  method: 'POST',
  headers: { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
  body: JSON.stringify(items.map((item) => ({ ...item, active: true, review_status: 'approved', source: 'briefing_sofas_may' }))),
});
if (!response.ok) throw new Error(`Import failed ${response.status}: ${await response.text()}`);
console.log(`Imported ${items.length} approved Sofas May knowledge records.`);

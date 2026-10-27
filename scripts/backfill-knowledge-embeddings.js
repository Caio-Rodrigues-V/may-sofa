import { config, assertIsolatedConfiguration } from '../src/config.js';
import { fetchQueryEmbedding } from '../src/supabase.js';

assertIsolatedConfiguration();
if (!config.supabaseUrl || !config.supabaseKey) throw new Error('Configure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before backfilling.');
const headers = { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}`, 'Content-Type': 'application/json' };
const base = `${config.supabaseUrl}/rest/v1/${config.tablePrefix}knowledge`;

const response = await fetch(`${base}?select=id,title,content&embedding=is.null`, { headers });
if (!response.ok) throw new Error(`Load failed ${response.status}: ${await response.text()}`);
const cards = await response.json();
for (const card of cards) {
  const embedding = await fetchQueryEmbedding(`${card.title} ${card.content}`);
  const update = await fetch(`${base}?id=eq.${card.id}`, { method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify({ embedding }) });
  if (!update.ok) throw new Error(`Update ${card.id} failed ${update.status}: ${await update.text()}`);
}
console.log(`Generated embeddings for ${cards.length} Sofas May knowledge cards.`);

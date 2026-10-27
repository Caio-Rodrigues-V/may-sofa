import fs from 'node:fs';
import path from 'node:path';
import { config, assertIsolatedConfiguration } from '../src/config.js';

assertIsolatedConfiguration();
if (!config.supabaseUrl || !config.supabaseKey) throw new Error('Dedicated Sofas May Supabase configuration is required.');

const mediaDirectory = path.resolve(process.argv[2] || new URL('../data/mvp-media', import.meta.url).pathname);
const models = [
  { name: 'Bahamas', slug: 'bahamas', file: 'bahamas.jpg' },
  { name: 'Lins', slug: 'lins', file: 'lins.jpg' },
  { name: 'Malibu', slug: 'malibu', file: 'malibu.jpg' },
  { name: 'Milano', slug: 'milano', file: 'milano.jpg' },
  { name: 'Zurich', slug: 'zurich', file: 'zurich.jpg' },
];

const authHeaders = { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` };
async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...authHeaders, 'Content-Type': 'application/json', ...options.headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

for (const model of models) {
  const filePath = path.join(mediaDirectory, model.file);
  if (!fs.existsSync(filePath)) throw new Error(`Missing normalized image: ${model.file}`);
  const [product] = await jsonRequest(`${config.supabaseUrl}/rest/v1/${config.tablePrefix}products?on_conflict=slug`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({
      name: model.name,
      slug: model.slug,
      product_type: 'sofa',
      short_description: null,
      technical_specs: {},
      official_url: null,
      active: true,
      review_status: 'approved',
    }),
  });

  const storagePath = `products/${model.slug}/${model.file}`;
  const upload = await fetch(`${config.supabaseUrl}/storage/v1/object/${config.catalogBucket}/${storagePath}`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
    body: fs.readFileSync(filePath),
  });
  if (!upload.ok) throw new Error(`Upload ${model.file} failed: ${upload.status} ${await upload.text()}`);

  const lookup = new URL(`${config.supabaseUrl}/rest/v1/${config.tablePrefix}media`);
  lookup.searchParams.set('select', 'id');
  lookup.searchParams.set('product_id', `eq.${product.id}`);
  lookup.searchParams.set('storage_bucket', `eq.${config.catalogBucket}`);
  lookup.searchParams.set('storage_path', `eq.${storagePath}`);
  const existing = await jsonRequest(lookup);
  const mediaRecord = {
    product_id: product.id,
    variant_id: null,
    media_type: 'image',
    mime_type: 'image/jpeg',
    storage_bucket: config.catalogBucket,
    storage_path: storagePath,
    public_url: null,
    original_filename: model.file,
    sort_order: 0,
    active: true,
    review_status: 'approved',
  };
  if (existing.length) {
    await jsonRequest(`${config.supabaseUrl}/rest/v1/${config.tablePrefix}media?id=eq.${existing[0].id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(mediaRecord),
    });
  } else {
    await jsonRequest(`${config.supabaseUrl}/rest/v1/${config.tablePrefix}media`, {
      method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(mediaRecord),
    });
  }
  console.log(`${model.name}\t${product.id}\t${storagePath}`);
}

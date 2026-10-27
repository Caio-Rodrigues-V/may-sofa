import { config } from './config.js';

const headers = { apikey: config.supabaseKey, Authorization: `Bearer ${config.supabaseKey}` };
const table = (name) => `${config.tablePrefix}${name}`;
export const normalize = (value = '') => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function rest(path, options = {}) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, { ...options, headers: { ...headers, 'Content-Type': 'application/json', ...options.headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  if (!text.trim()) return null;
  return JSON.parse(text);
}
const rows = (name, query) => rest(`${table(name)}?${query}`);

export async function findCatalog(query) {
  const needle = normalize(query);
  const tokens = needle.split(' ').filter((x) => x.length > 2);
  const [products, aliases] = await Promise.all([
    rows('products', 'select=*&active=eq.true&review_status=eq.approved'),
    rows('product_aliases', 'select=product_id,alias,normalized_alias'),
  ]);
  const aliasMap = new Map();
  for (const alias of aliases) aliasMap.set(alias.product_id, [...(aliasMap.get(alias.product_id) || []), normalize(alias.alias)]);
  const matches = products.map((product) => {
    const haystack = normalize([product.name, product.slug, product.product_type, product.short_description, ...(aliasMap.get(product.id) || [])].join(' '));
    const identities = [product.name, product.slug, ...(aliasMap.get(product.id) || [])].map(normalize).filter(Boolean);
    const explicitScore = identities.some((identity) => new RegExp(`(^| )${identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(needle)) ? 50 : 0;
    return { product, score: explicitScore + (needle && haystack.includes(needle) ? 20 : 0) + tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 2 : 0), 0) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4);

  // Fallback to all approved products when no specific match is found
  const selectedProducts = matches.length > 0 ? matches.map((m) => m.product) : products.slice(0, 5);

  return Promise.all(selectedProducts.map(async (product) => {
    const [variants, prices, media] = await Promise.all([
      rows('product_variants', `select=*&product_id=eq.${product.id}&active=eq.true&review_status=eq.approved&order=exact_width_cm.asc.nullslast`),
      rows('prices', `select=*&product_id=eq.${product.id}&active=eq.true&review_status=eq.approved`),
      rows('media', `select=*&product_id=eq.${product.id}&active=eq.true&review_status=eq.approved&order=sort_order.asc&limit=4`),
    ]);
    return { ...product, aliases: aliasMap.get(product.id) || [], variants, prices, media };
  }));
}

export async function findCommercialRules() {
  const now = new Date();
  const rules = await rows('commercial_rules', 'select=rule_key,rule_value,effective_from,effective_until&active=eq.true&review_status=eq.approved');
  return rules.filter((rule) => (!rule.effective_from || new Date(rule.effective_from) <= now) && (!rule.effective_until || new Date(rule.effective_until) >= now));
}

export const isKnowledgeSemanticEnabled = () => String(process.env.KNOWLEDGE_SEMANTIC_ENABLED || 'false').toLowerCase() === 'true';

export async function fetchQueryEmbedding(text, { fetchImpl = fetch, signal } = {}) {
  if (!config.openaiKey) throw new Error('openai_api_key_missing');
  const response = await fetchImpl('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.openaiEmbeddingModel, input: text }),
    signal,
  });
  if (!response.ok) throw new Error(`OpenAI Embeddings ${response.status}: ${await response.text()}`);
  const embedding = (await response.json())?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error('invalid_embedding_response');
  return embedding;
}

export async function matchKnowledgeRpc(embedding, { limit = 6, fetchImpl = fetch, signal } = {}) {
  const fn = `${config.tablePrefix}match_knowledge`;
  const response = await fetchImpl(`${config.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_embedding: embedding, p_limit: limit }),
    signal,
  });
  if (!response.ok) throw new Error(`RPC ${fn} ${response.status}: ${await response.text()}`);
  const records = await response.json();
  return Array.isArray(records) ? records : [];
}

// Busca semântica nos cards treinados pelo painel; cai para busca por palavras se falhar ou vier vazia.
export async function findKnowledge(query, { fetchImpl = fetch } = {}) {
  const text = String(query || '').trim();
  if (isKnowledgeSemanticEnabled() && text) {
    try {
      const signal = AbortSignal.timeout(2500);
      const embedding = await fetchQueryEmbedding(text, { fetchImpl, signal });
      const results = filterKnowledgePrices(await matchKnowledgeRpc(embedding, { limit: 6, fetchImpl, signal }));
      if (results.length > 0) {
        console.log(JSON.stringify({ level: 'info', event: 'knowledge_retrieved', mode: 'semantic', count: results.length, titles: results.map((item) => item.title) }));
        return results;
      }
    } catch (error) {
      console.warn(JSON.stringify({ level: 'warn', event: 'knowledge_semantic_failed', error: error?.message, fallback: 'keyword' }));
    }
  }
  return findKnowledgeByKeywords(query);
}

async function findKnowledgeByKeywords(query) {
  const tokens = normalize(query).split(' ').filter((x) => x.length > 3);
  const knowledge = await rows('knowledge', 'select=topic,title,content,priority&active=eq.true&review_status=eq.approved&order=priority.desc&limit=400');
  const filtered = filterKnowledgePrices(knowledge);
  if (filtered.length !== knowledge.length) console.log(JSON.stringify({ level: 'info', event: 'knowledge_filtered', knowledge_price_filtered: true, count: knowledge.length - filtered.length }));
  return filtered
    .map((item) => ({ item, score: tokens.reduce((sum, token) => sum + (normalize(`${item.topic} ${item.title} ${item.content}`).includes(token) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map((x) => x.item);
}

export function hasLegacyPriceContent(item) {
  const topic = normalize(item?.topic);
  const content = String(item?.content || '');
  if (topic === 'legacy price') return true;
  return /R\$|\b\d[\d.,]*\s*reais?\b|\b(?:a|à)\s+vista\b|\bparcelad[oa]\b|\bparcelas?\b|\b(?:10|12|18)\s*x\b|\b\d+\s*vezes\s+de\s+\d|\bpor\s+apenas\b|\bde\s+R?\$?\s*\d[\d.,]*\s+por\s+R?\$?\s*\d|(?:\bpix\b[^.!?]{0,50}\d|\d[^.!?]{0,50}\bpix\b)/i.test(content);
}

export function filterKnowledgePrices(items = []) {
  return items.filter((item) => !hasLegacyPriceContent(item));
}

export async function findProductLinkKnowledge(product) {
  if (!product) return [];
  const knowledge = await rows('knowledge', 'select=topic,title,content,priority&active=eq.true&review_status=eq.approved&order=priority.desc&limit=400');
  return sanitizeProductLinkKnowledge(knowledge, product);
}

export function sanitizeProductLinkKnowledge(knowledge, product) {
  const identities = [product.name, product.slug, ...(product.aliases || [])].map(normalize).filter(Boolean);
  return knowledge.filter((item) => {
    const text = normalize(`${item.title} ${item.content}`);
    return identities.some((identity) => text.includes(identity)) && /https?:\/\//i.test(item.content);
  }).map((item) => {
    const urls = String(item.content).match(/https?:\/\/[^\s)\]}>,"']+/gi) || [];
    const siteOnly = /(?:somente|exclusiv\w*)\s+(?:no|pelo)\s+site|vendid\w+\s+(?:somente|exclusiv\w*)[^.]*site/i.test(item.content);
    return { ...item, content: `${siteOnly ? 'Vendido somente pelo site. ' : ''}${urls.join(' ')}`.trim() };
  });
}

export async function mediaUrl(media) {
  if (media.public_url) return media.public_url;
  const response = await fetch(`${config.supabaseUrl}/storage/v1/object/sign/${encodeURIComponent(media.storage_bucket)}/${media.storage_path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600 }) });
  if (!response.ok) throw new Error(`Supabase storage ${response.status}: ${await response.text()}`);
  const body = await response.json();
  return body.signedURL.startsWith('http') ? body.signedURL : `${config.supabaseUrl}/storage/v1${body.signedURL}`;
}

export async function findActivePrompt() {
  const versions = await rows('prompt_versions', 'select=version,prompt_text,active,created_at&active=eq.true&order=created_at.desc&limit=1');
  return versions?.[0] || null;
}

export async function logEvent(event) {
  await rest(table('events'), { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(event) });
}

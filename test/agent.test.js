import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertIsolatedConfiguration, config } from '../src/config.js';
import { applyResolvedProductState, classifyServiceType, detectIntent, normalizeSessionState, requestedWidth, resolveContextProduct, shouldShortCircuitHuman } from '../src/conversation.js';
import { filterKnowledgePrices } from '../src/supabase.js';
import { resolveProductLink, resolveVariantOffer } from '../src/catalog.js';
import { selectProductMedia } from '../src/media.js';

test('uses isolated defaults', () => {
  assert.equal(config.tablePrefix, 'sofas_may_');
  assert.equal(config.redisPrefix, 'sofas-may:');
  assert.equal(config.catalogBucket, 'sofas-may-catalog');
  assert.doesNotThrow(assertIsolatedConfiguration);
});

test('new session never inherits product or human state', () => {
  const state = normalizeSessionState();
  assert.equal(state.currentProductId, null);
  assert.equal(state.currentWidthCm, null);
  assert.equal(state.humanControl, false);
});

test('commercial category request is classified', () => assert.equal(classifyServiceType('quero conhecer os colchões'), 'commercial'));
test('support intent is classified', () => assert.equal(classifyServiceType('meu produto chegou com defeito'), 'post_sale'));
test('quote intent is detected', () => assert.equal(detectIntent('quero um orçamento'), 'product_price'));
test('human request is detected', () => assert.equal(detectIntent('quero falar com um vendedor'), 'human_request'));
test('explicit width is parsed', () => assert.equal(requestedWidth('preciso de 2,30 metros').widthCm, 230));
test('price and CEP do not become width', () => {
  assert.equal(requestedWidth('18x de R$ 244').widthCm, null);
  assert.equal(requestedWidth('CEP 09290-520').widthCm, null);
});

test('explicit product selection updates current product', () => {
  const products = [{ id: 'a', name: 'Modelo Aurora', slug: 'modelo-aurora', aliases: [] }];
  const state = normalizeSessionState();
  const resolution = resolveContextProduct(products, 'quero o Modelo Aurora', state);
  applyResolvedProductState(state, resolution, requestedWidth('quero o Modelo Aurora'));
  assert.equal(state.currentProductId, 'a');
});

test('product change clears stale width', () => {
  const state = normalizeSessionState({ currentProductId: 'a', currentProduct: 'A', currentWidthCm: 220 });
  applyResolvedProductState(state, { status: 'resolved', product: { id: 'b', name: 'B' }, source: 'explicit' }, requestedWidth('quero B'));
  assert.equal(state.currentWidthCm, null);
});

test('exact variant has priority over range', () => {
  const product = { variants: [{ id: 'range', exact_width_cm: null, min_width_cm: 200, max_width_cm: 240 }, { id: 'exact', exact_width_cm: 220, min_width_cm: null, max_width_cm: null }], prices: [{ id: 'p1', variant_id: 'range', channel: 'whatsapp', cash_price: 1 }, { id: 'p2', variant_id: 'exact', channel: 'whatsapp', cash_price: 2 }] };
  assert.equal(resolveVariantOffer(product, 220, 'whatsapp').variant.id, 'exact');
});

test('price lookup does not cross channel', () => {
  const product = { variants: [{ id: 'v', exact_width_cm: 200 }], prices: [{ variant_id: 'v', channel: 'website', cash_price: 1 }] };
  assert.equal(resolveVariantOffer(product, 200, 'whatsapp').status, 'no_match');
});

test('conflicting exact prices are ambiguous', () => {
  const product = { variants: [{ id: 'v', exact_width_cm: 200 }], prices: [{ variant_id: 'v', channel: 'whatsapp', cash_price: 1 }, { variant_id: 'v', channel: 'whatsapp', cash_price: 2 }] };
  assert.equal(resolveVariantOffer(product, 200, 'whatsapp').status, 'ambiguous');
});

test('media selection never crosses product and accepts product-level media', () => {
  const product = { id: 'a', media: [{ id: 'm1', product_id: 'a', variant_id: null }, { id: 'm2', product_id: 'a', variant_id: 'v2' }] };
  const selected = selectProductMedia(product, normalizeSessionState({ currentVariantId: 'v1' }));
  assert.deepEqual(selected.map((item) => item.id), ['m1']);
});

test('human control silences agent', () => assert.equal(shouldShortCircuitHuman(normalizeSessionState({ humanControl: true }), false), true));

test('legacy prices in knowledge are rejected', () => {
  const items = [{ title: 'institutional', content: 'Endereço da loja' }, { title: 'price', content: '18x de R$ 100' }];
  assert.deepEqual(filterKnowledgePrices(items), [items[0]]);
});

test('product official URL has priority and is never invented', () => {
  assert.equal(resolveProductLink({ id: 'a', name: 'A', slug: 'a', official_url: 'https://sofasmay.com.br/a' }).url, 'https://sofasmay.com.br/a');
  assert.equal(resolveProductLink({ id: 'b', name: 'B', slug: 'b' }).url, null);
});

test('prompt contains no catalog model from the template', () => {
  const prompt = readFileSync(new URL('../SYSTEM-PROMPT.txt', import.meta.url), 'utf8');
  assert.doesNotMatch(prompt, /Milano|Veneza|Atlanta|Bahamas|Póllo|Fonte do Sofá/i);
});

test('prompt reload uses the active panel version and keeps the file fallback on failure', async () => {
  const { getPromptVersion, getSystemPrompt, reloadSystemPrompt } = await import('../src/agent.js');
  const fallback = getSystemPrompt();
  const failed = await reloadSystemPrompt({ loadPrompt: async () => { throw new Error('offline'); } });
  assert.equal(failed.success, false);
  assert.equal(getSystemPrompt(), fallback);
  const loaded = await reloadSystemPrompt({ loadPrompt: async () => ({ version: 'painel-v2', prompt_text: 'Prompt do painel' }) });
  assert.equal(loaded.source, 'supabase');
  assert.equal(getSystemPrompt(), 'Prompt do painel');
  assert.equal(getPromptVersion(), 'painel-v2');
});

test('semantic knowledge search calls the tenant RPC and filters prices', async () => {
  const { findKnowledge } = await import('../src/supabase.js');
  const previous = { semantic: process.env.KNOWLEDGE_SEMANTIC_ENABLED, key: config.openaiKey, url: config.supabaseUrl };
  process.env.KNOWLEDGE_SEMANTIC_ENABLED = 'true';
  config.openaiKey = 'test-key';
  config.supabaseUrl = 'https://example.supabase.co';
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.includes('/embeddings')) return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    assert.equal(JSON.parse(options.body).p_limit, 6);
    return new Response(JSON.stringify([
      { topic: 'entrega', title: 'Prazo', content: 'Entregamos em até 15 dias úteis.', similarity: 0.8 },
      { topic: 'oferta', title: 'Promo', content: 'Por apenas R$ 999 à vista.', similarity: 0.7 },
    ]));
  };
  try {
    const results = await findKnowledge('qual o prazo de entrega', { fetchImpl });
    assert.deepEqual(results.map((item) => item.title), ['Prazo']);
    assert.ok(calls.some((url) => url.endsWith('/rest/v1/rpc/sofas_may_match_knowledge')));
  } finally {
    process.env.KNOWLEDGE_SEMANTIC_ENABLED = previous.semantic;
    if (previous.semantic === undefined) delete process.env.KNOWLEDGE_SEMANTIC_ENABLED;
    config.openaiKey = previous.key;
    config.supabaseUrl = previous.url;
  }
});

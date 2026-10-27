import { normalize } from './supabase.js';

function isCurrentlyValid(price, now = new Date()) {
  return (!price.valid_from || new Date(price.valid_from) <= now) && (!price.valid_until || new Date(price.valid_until) >= now);
}

function sameOffer(a, b) {
  return ['list_price', 'cash_price', 'installment_count', 'installment_value', 'discount_percent', 'currency', 'channel'].every((key) => String(a[key] ?? '') === String(b[key] ?? ''));
}

export function paymentChannelPolicy(channel) {
  const normalized = normalize(channel);
  if (normalized === 'website' || normalized === 'site') return { channel: 'website', maxInstallments: 12, label: 'site' };
  if (normalized === 'pay on delivery' || normalized === 'pay_on_delivery' || normalized === 'pague na entrega') return { channel: 'pay_on_delivery', maxInstallments: 18, label: 'pague na entrega' };
  if (normalized === 'showroom') return { channel: 'showroom', maxInstallments: 18, label: 'showroom' };
  return { channel: channel || null, maxInstallments: null, label: channel || 'atendimento' };
}

export function resolveVariantOffer(product, widthCm, channel = 'whatsapp', options = {}) {
  const now = options.now || new Date();
  if (!product || widthCm === null) return { status: 'missing_input', product, widthCm, channel, candidates: [] };
  const exact = product.variants.filter((variant) => variant.exact_width_cm !== null && Number(variant.exact_width_cm) === Number(widthCm));
  const ranges = product.variants.filter((variant) => variant.exact_width_cm === null
    && variant.min_width_cm !== null && variant.max_width_cm !== null
    && Number(widthCm) >= Number(variant.min_width_cm) && Number(widthCm) <= Number(variant.max_width_cm));
  const candidatesFor = (variants) => variants.flatMap((variant) => product.prices
    .filter((price) => price.variant_id === variant.id && price.channel === channel && isCurrentlyValid(price, now))
    .map((price) => ({ variant, price })));
  let selectedExact = options.variantId ? exact.filter((variant) => variant.id === options.variantId) : exact;
  let selectedRanges = options.variantId ? ranges.filter((variant) => variant.id === options.variantId) : ranges;
  let candidates = candidatesFor(selectedExact);
  if (candidates.length === 0) candidates = candidatesFor(selectedRanges);
  if (candidates.length === 0) return { status: 'no_match', product, widthCm, channel, candidates: [] };
  if (candidates.length > 1) {
    const first = candidates[0];
    const equivalent = candidates.every((candidate) => candidate.variant.id === first.variant.id && sameOffer(candidate.price, first.price));
    if (!equivalent) return { status: 'ambiguous', product, widthCm, channel, candidates };
  }
  return { status: 'matched', product, widthCm, channel, variant: candidates[0].variant, price: candidates[0].price, candidates };
}

function urlsFromText(text) {
  return String(text || '').match(/https?:\/\/[^\s)\]}>,"']+/gi) || [];
}

function ruleMatchesProduct(rule, product) {
  const value = rule.rule_value || {};
  return value.product_id === product.id
    || normalize(value.product_slug) === normalize(product.slug)
    || normalize(value.product_name) === normalize(product.name)
    || normalize(rule.rule_key).includes(normalize(product.slug || product.name));
}

export function resolveProductLink(product, knowledge = [], commercialRules = []) {
  if (!product) return { url: null, source: null, siteOnly: false };
  if (product.official_url) return { url: product.official_url, source: 'product', siteOnly: false };
  for (const rule of commercialRules.filter((item) => ruleMatchesProduct(item, product))) {
    const value = rule.rule_value || {};
    const url = value.official_url || value.product_url || value.url;
    if (url) return { url, source: 'commercial_rule', siteOnly: Boolean(value.site_only || value.exclusive_channel === 'website' || value.channel === 'website') };
  }
  const relevant = knowledge.filter((item) => normalize(`${item.title} ${item.content}`).includes(normalize(product.name)));
  const urls = [...new Set(relevant.flatMap((item) => urlsFromText(item.content)))];
  const siteOnly = relevant.some((item) => /(?:somente|exclusiv\w*)\s+(?:no|pelo)\s+site|vendid\w+\s+(?:somente|exclusiv\w*)[^.]*site/i.test(item.content));
  const productPathTokens = [product.slug, product.name].map(normalize).filter(Boolean);
  const productPages = urls.filter((url) => /\/produtos?\//i.test(url) && productPathTokens.some((token) => normalize(url).includes(token)));
  if (productPages.length === 1) return { url: productPages[0], source: 'knowledge_product_page', siteOnly };
  if (productPages.length > 1) return { url: null, source: 'ambiguous_knowledge_product_page', siteOnly };
  return urls.length === 1 ? { url: urls[0], source: 'knowledge', siteOnly } : { url: null, source: urls.length > 1 ? 'ambiguous_knowledge' : null, siteOnly };
}

export function shouldAllowLink({ explicitRequest, purchaseIntent, link }) {
  return Boolean(link?.url && (explicitRequest || (purchaseIntent && link.siteOnly)));
}

export function compactCatalog(products) {
  return products.map((product) => ({
    id: product.id,
    nome: product.name,
    tipo: product.product_type,
    descricao: product.short_description,
    especificacoes: product.technical_specs,
    variantes: product.variants.map((variant) => ({
      id: variant.id,
      nome: variant.label,
      largura_min_cm: variant.min_width_cm,
      largura_max_cm: variant.max_width_cm,
      largura_cm: variant.exact_width_cm,
      tecido: variant.fabric,
      cor: variant.color,
      configuracao: variant.configuration,
      especificacoes: variant.technical_specs,
    })),
    possui_midia: product.media.length > 0,
    url_oficial: product.official_url || null,
  }));
}

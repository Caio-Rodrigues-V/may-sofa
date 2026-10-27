import { normalize } from './supabase.js';

const REFERENCE_PATTERN = /\b(esse|essa|isso|ele|dele|desse|dessa|esse a[ií]|esse sof[aá]|esse modelo|quero esse|ver esse|foto dele|fotos dele)\b/i;

export function normalizeSessionState(value = {}) {
  const serviceType = 'commercial';
  return {
    history: Array.isArray(value.history) ? value.history : [],
    human: Boolean(value.human),
    humanReason: value.humanReason || null,
    humanControl: Boolean(value.humanControl || value.human),
    transferRequested: Boolean(value.transferRequested),
    transfer: normalizeTransfer(value.transfer, value.transferRequested),
    currentProductId: value.currentProductId || null,
    currentProduct: value.currentProduct || null,
    currentVariantId: value.currentVariantId || null,
    currentWidthCm: value.currentWidthCm !== null && value.currentWidthCm !== undefined && Number.isFinite(Number(value.currentWidthCm)) ? Number(value.currentWidthCm) : null,
    lastSuggestedProducts: normalizeSuggestions(value.lastSuggestedProducts),
    lastIntent: value.lastIntent || null,
    stage: value.stage || 'discovery',
    sentMedia: Array.isArray(value.sentMedia) ? value.sentMedia : [],
    delivery: normalizeDelivery(value.delivery),
    processedMessageIds: Array.isArray(value.processedMessageIds) ? value.processedMessageIds : [],
    products: Array.isArray(value.products) ? value.products : [],
    cardId: value.cardId || null,
    serviceType,
    supportRequested: Boolean(value.supportRequested || value.serviceType === 'post_sale'),
    supportContext: value.supportContext || null,
    supportTagApplied: Boolean(value.supportTagApplied),
    supportNoteAdded: Boolean(value.supportNoteAdded),
    assignedTeamId: value.assignedTeamId || null,
    lead: normalizeLead(value.lead),
    lastPresentedOffer: normalizePresentedOffer(value.lastPresentedOffer),
    closingIntent: Boolean(value.closingIntent),
    afterHoursLead: Boolean(value.afterHoursLead),
    consultantFollowUpPending: Boolean(value.consultantFollowUpPending),
    pendingAction: normalizePendingAction(value.pendingAction),
  };
}

function normalizePendingAction(value) {
  if (value?.type !== 'SEND_SITE_LINK' || !value.url) return null;
  return { type: 'SEND_SITE_LINK', productId: value.productId || null, url: value.url };
}

export function isSupportRequest(text) {
  const input = normalize(String(text || ''));
  if (/\b(?:quero|preciso)\s+(?:falar\s+)?(?:com\s+)?(?:o\s+)?suporte\b|\bpreciso\s+de\s+assistencia\b/.test(input)) return true;
  return classifyServiceType(text) === 'post_sale';
}

function normalizeLead(value = {}) {
  return {
    paymentMethod: value.paymentMethod || null,
    cep: value.cep || null,
    city: value.city || null,
    fabric: value.fabric || null,
    color: value.color || null,
    intent: value.intent || null,
  };
}

function normalizePresentedOffer(value) {
  if (!value?.productId || !value?.priceId) return null;
  return {
    productId: value.productId,
    product: value.product || null,
    variantId: value.variantId || null,
    widthCm: Number.isFinite(Number(value.widthCm)) ? Number(value.widthCm) : null,
    priceId: value.priceId,
    channel: value.channel || null,
    cashPrice: value.cashPrice ?? null,
    installmentCount: value.installmentCount ?? null,
    installmentValue: value.installmentValue ?? null,
    presentedAt: value.presentedAt || null,
  };
}

export function updateLeadQualification(state, text, intent = null) {
  const input = normalize(String(text || ''));
  const payment = input.match(/\b(pix|cartao\s+parcelado|cartao|boleto|dinheiro)\b/);
  const cep = String(text || '').match(/\b\d{5}-?\d{3}\b/);
  const fabric = input.match(/\b(linho|veludo|boucle|suede|couro|courino)\b/);
  const color = input.match(/\b(bege|cinza|preto|branco|azul|verde|marrom|caramelo|off white)\b/);
  if (payment) state.lead.paymentMethod = payment[1];
  if (cep) state.lead.cep = cep[0];
  if (fabric) state.lead.fabric = fabric[1];
  if (color) state.lead.color = color[1];
  if (intent) state.lead.intent = intent;
  return state.lead;
}

export function classifyServiceType(text) {
  const input = normalize(String(text || '').trim());
  if (input === '1') return 'commercial';
  if (input === '2') return 'post_sale';

  const postSale = /\b(?:ja\s+(?:comprei|fiz\s+(?:a\s+)?compra)|comprei\s+(?:um|uma|o|a)?\s*(?:sofa|produto|colchao|cama)[^.!?]*(?:danificad[oa]|com\s+problema|com\s+defeito|quebrad[oa]|avariad[oa])|(?:ajuda|suporte)\s+com\s+(?:um|uma|o|a)?\s*(?:produto|sofa|colchao|cama)\s+(?:danificad[oa]|com\s+problema|com\s+defeito|quebrad[oa]|avariad[oa])|(?:produto|sofa|colchao|cama)\s+(?:que\s+)?(?:veio|chegou)\s+(?:com\s+)?(?:danificad[oa]|problema|defeito|quebrad[oa]|avariad[oa])|compra\s+ja\s+realizada|(?:e\s+)?sobre\s+(?:o\s+)?meu\s+pedido|meu\s+pedido\s+(?:esta\s+)?(?:atrasado|com\s+problema|nao\s+chegou|ainda\s+nao\s+chegou)|onde\s+esta\s+(?:o\s+)?meu\s+pedido|(?:minha\s+)?entrega\s+(?:esta\s+)?(?:atrasada|nao\s+chegou|ainda\s+nao\s+chegou)|meu\s+(?:sofa|produto)\s+(?:chegou\s+)?(?:com\s+)?(?:problema|defeito|danificado|quebrado|avariado)|chegou\s+(?:com\s+)?(?:problema|defeito|danificado|quebrado|avariado)|(?:problema|defeito)\s+(?:no|com\s+o|com\s+meu)\s+(?:pedido|sofa|produto|pagamento)|pagamento\s+do\s+pedido|acionar\s+(?:a\s+)?garantia|usar\s+(?:a\s+)?garantia|quero\s+(?:trocar|devolver|cancelar\s+(?:meu\s+)?pedido)|troca|devolucao|assistencia\s+tecnica|pos\s+venda|segunda\s+via)\b/;
  if (postSale.test(input)) return 'post_sale';

  const commercial = /\b(?:quero\s+(?:comprar|conhecer|ver)|nova\s+compra|conhecer\s+(?:os\s+)?(?:sofas|produtos)|ver\s+(?:os\s+)?modelos|quanto\s+(?:custa|fica)|qual\s+(?:o\s+)?(?:preco|valor)|preco|valor|orcamento|catalogo|modelos?\s+de\s+(?:sofa|poltrona|colchao)|comprar\s+(?:um\s+)?(?:sofa|produto|colchao|poltrona|base)|sofa\s+(?:retratil|cama|fixo|com\s+chaise))\b/;
  if (commercial.test(input)) return 'commercial';
  return 'unknown';
}

export function resolveServiceType(current, text) {
  const detected = classifyServiceType(text);
  if (current === 'unknown') return detected;
  if (current === 'commercial' && detected === 'post_sale') return 'post_sale';
  if (current === 'post_sale' && detected === 'commercial' && /\b(nova\s+compra|quero\s+(?:comprar|conhecer|ver\s+(?:os\s+)?modelos)|quanto\s+(?:custa|fica))\b/i.test(normalize(text))) return 'commercial';
  return current;
}

function normalizeTransfer(value, legacyRequested = false) {
  const status = ['none', 'pending', 'completed', 'failed'].includes(value?.status)
    ? value.status
    : (legacyRequested ? 'completed' : 'none');
  return {
    status,
    operationId: value?.operationId || null,
    sessionId: value?.sessionId || null,
    to: value?.to || null,
    name: value?.name || null,
    messageId: value?.messageId || null,
    reason: value?.reason || null,
    attempts: Number(value?.attempts || 0),
    requestedAt: value?.requestedAt || null,
    completedAt: value?.completedAt || null,
    updatedAt: value?.updatedAt || null,
    nextRetryAt: value?.nextRetryAt || null,
    transferCompleted: Boolean(value?.transferCompleted || status === 'completed'),
    messageSent: Boolean(value?.messageSent),
    noteSent: Boolean(value?.noteSent),
    crmPrepared: Boolean(value?.crmPrepared),
    expectedTeamId: value?.expectedTeamId || null,
    requestedTeamId: value?.requestedTeamId || null,
    actualTeamId: value?.actualTeamId || null,
    actualTeamName: value?.actualTeamName || null,
    lastError: value?.lastError || null,
  };
}

function normalizeDelivery(value) {
  return {
    messageId: value?.messageId || null,
    textSent: Boolean(value?.textSent),
    sentMediaIds: Array.isArray(value?.sentMediaIds) ? value.sentMediaIds : [],
  };
}

export function normalizeSuggestions(items = []) {
  return items.map((item) => typeof item === 'string' ? { id: null, name: item } : { id: item.id || null, name: item.name }).filter((item) => item.name);
}

export function requestedWidth(text) {
  const input = String(text);
  const blocked = /(?:R\$|\breais?\b|\b\d+\s*x\b|\bparcelas?\b|%|\bdesconto\b|\blugares?\b|\bassentos?\b|\bvezes\b|\bpedido\b|\bc[oó]digo\b|\bCEP\b)/i;
  const compound = input.match(/\b(\d)\s*metros?\s+e\s+(\d{1,2})\b/i);
  if (compound) return { widthCm: (Number(compound[1]) * 100) + Number(compound[2]), source: 'explicit_unit' };

  const explicit = input.match(/\b(\d{1,3}(?:[.,]\d{1,2})?)\s*(m|metros?|cm|cent[ií]metros?)\b/i);
  if (explicit) {
    const value = Number(explicit[1].replace(',', '.'));
    if (Number.isFinite(value) && value > 0) return { widthCm: Math.round(explicit[2].toLowerCase().startsWith('c') ? value : value * 100), source: 'explicit_unit' };
  }

  const contextual = input.match(/\b(\d[.,]\d{1,2})\b/);
  const hasWidthContext = /\b(?:medida|largura|tamanho|sof[aá]|modelo|quero\s+(?:o|um|uma)?|tem\s+de|fica\s+(?:o|um)?|de)\b/i.test(input)
    || /\b[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'-]+\s+\d[.,]\d{1,2}\b/.test(input);
  if (contextual && hasWidthContext && !blocked.test(input)) {
    const value = Number(contextual[1].replace(',', '.'));
    if (value >= 1 && value <= 5) return { widthCm: Math.round(value * 100), source: 'contextual_decimal' };
  }
  return { widthCm: null, source: blocked.test(input) ? 'rejected_context' : null };
}

export function requestedWidthCm(text) {
  return requestedWidth(text).widthCm;
}

export function requestedConfiguration(text) {
  const value = normalize(text);
  if (/\bbi partido\b|\bbipartido\b/.test(value)) return 'bi partido';
  if (/\binteiro\b|\buma pe[cç]a\b/.test(value)) return 'inteiro';
  return null;
}

export function buildSearchQuery(state, text) {
  const recentUserMessages = state.history.filter((item) => item.role === 'user').slice(-4).map((item) => item.content);
  return [state.currentProduct, ...state.lastSuggestedProducts.map((item) => item.name), ...recentUserMessages, text].filter(Boolean).join(' ');
}

export function explicitlyWantsHuman(text) {
  return /\b(?:falar|conversar|atendimento)\s+(?:com\s+)?(?:um[oa]?\s+)?(?:vendedor(?:a)?|atendente|consultor(?:a)?|humano|pessoa)\b|\b(?:quero|preciso)\s+(?:de\s+)?(?:um[oa]?\s+)?(?:vendedor(?:a)?|atendente|consultor(?:a)?)\b/i.test(text);
}

export function requiresCommercialHandoff(text) {
  return /\b(desconto\s+(?:maior|adicional|extra)|melhorar\s+(?:esse\s+)?pre[cç]o|negociar|condi[cç][aã]o\s+especial|reclama[cç][aã]o|p[oó]s[- ]?venda|problema\s+(?:com|no)\s+pagamento|reservar|fechar\s+(?:a\s+)?compra|sof[aá]\s+de\s+canto[^.!?]*\d+(?:[.,]\d+)?\s*[mx]\s*\d+(?:[.,]\d+)?|(?:or[cç]amento|cota[cç][aã]o|projeto|medida|configura[cç][aã]o)\s+(?:personalizad[oa]|sob\s+medida))\b/i.test(text);
}

export function detectIntent(text, previousAssistantMessage = '') {
  const affirmative = /^(s|ss|sim|sim por favor|pode|pode sim|sim,? pode(?: me)? (?:mandar|enviar)|manda|mande|claro|quero|por favor)[!. ]*$/i.test(String(text).trim());
  if (explicitlyWantsHuman(text)) return 'human_request';
  if (requiresCommercialHandoff(text)) return 'commercial_handoff';
  if (affirmative && /Quer seguir com essa op[cç][aã]o\?/i.test(previousAssistantMessage)) return 'offer_acceptance';
  if (/\b(como\s+(?:eu\s+)?(?:pago|posso\s+pagar|fecho|finalizo)|como\s+fa[cç]o\s+para\s+comprar|quero\s+(?:pagar|fechar|comprar|ficar\s+com|esse)|vou\s+ficar\s+com|pode\s+(?:fechar|seguir)|forma\s+de\s+pagamento|pagamento\s+(?:no|por|via)|(?:no|por|via)\s+(?:pix|cart[aã]o|boleto)|cart[aã]o\s+parcelado)\b/i.test(text)) return 'closing_intent';
  if (/\b(foto|fotos|imagem|imagens|v[ií]deo|mostra|mostrar|mostre|ver o modelo)\b/i.test(text) || (affirmative && /\b(foto|imagem|v[ií]deo|m[ií]dia)\b/i.test(previousAssistantMessage))) return 'product_media';
  if (/\b(pre[cç]o|valor|quanto custa|quanto fica|or[cç]amento)\b/i.test(text)) return 'product_price';
  if (/\b(link|site|p[aá]gina|mercado livre|onde comprar|comprar online|endere[cç]o do produto)\b/i.test(text) || (affirmative && /\b(link|site|p[aá]gina)\b/i.test(previousAssistantMessage))) return 'product_link';
  if (/\b(gostei desse)\b/i.test(text)) return 'purchase_interest';
  if (/\b(frete|entrega|prazo)\b/i.test(text)) return 'shipping';
  return 'discovery';
}

export function mentionedProducts(products, text) {
  const normalizedText = normalize(text);
  return products.filter((product) => [product.name, product.slug, ...(product.aliases || [])]
    .map(normalize)
    .filter(Boolean)
    .some((identity) => new RegExp(`(^| )${identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(normalizedText)));
}

export function resolveContextProduct(products, text, state) {
  const explicit = mentionedProducts(products, text);
  if (explicit.length === 1) return { status: 'resolved', product: explicit[0], source: 'explicit' };
  if (explicit.length > 1) return { status: 'ambiguous', candidates: explicit, source: 'explicit' };

  if (REFERENCE_PATTERN.test(text)) {
    const current = products.find((product) => product.id === state.currentProductId || product.name === state.currentProduct);
    if (current) return { status: 'resolved', product: current, source: 'current_reference' };
    if (state.lastSuggestedProducts.length === 1) {
      const suggestion = state.lastSuggestedProducts[0];
      const product = products.find((item) => item.id === suggestion.id || item.name === suggestion.name);
      if (product) return { status: 'resolved', product, source: 'single_suggestion_reference' };
    }
    if (state.lastSuggestedProducts.length > 1) return { status: 'ambiguous', candidates: state.lastSuggestedProducts, source: 'multiple_suggestions' };
  }

  const current = products.find((product) => product.id === state.currentProductId || product.name === state.currentProduct);
  return current ? { status: 'resolved', product: current, source: 'state' } : { status: 'none', product: null, source: 'none' };
}

export function shouldShortCircuitHuman(state, wtsOwned) {
  return Boolean(state.humanControl || state.human || wtsOwned);
}

export function suggestionsFromProducts(products) {
  return products.slice(0, 4).map((product) => ({ id: product.id, name: product.name }));
}

export function applyResolvedProductState(state, resolution, widthResult) {
  const explicitWidth = widthResult.widthCm;
  if (explicitWidth !== null && explicitWidth !== state.currentWidthCm) {
    state.currentWidthCm = explicitWidth;
    state.currentVariantId = null;
  }
  if (resolution.status !== 'resolved') return { productChanged: false, widthReset: false };
  const hadProduct = Boolean(state.currentProductId || state.currentProduct);
  const sameProduct = (state.currentProductId && state.currentProductId === resolution.product.id)
    || (!state.currentProductId && normalize(state.currentProduct) === normalize(resolution.product.name));
  const productChanged = hadProduct && !sameProduct;
  const widthReset = productChanged && explicitWidth === null;
  if (productChanged) {
    state.currentVariantId = null;
    state.lastSuggestedProducts = [];
    if (widthReset) state.currentWidthCm = null;
  }
  state.currentProductId = resolution.product.id;
  state.currentProduct = resolution.product.name;
  if (resolution.source === 'explicit') state.lastSuggestedProducts = [];
  return { productChanged, widthReset };
}

export function applyAnswerProductsState(state, products) {
  if (products.length > 1) {
    state.lastSuggestedProducts = suggestionsFromProducts(products);
    state.currentProductId = null;
    state.currentProduct = null;
    state.currentVariantId = null;
    return;
  }
  if (products.length === 1) {
    if (state.currentProductId && state.currentProductId !== products[0].id) state.currentVariantId = null;
    state.currentProductId = products[0].id;
    state.currentProduct = products[0].name;
    state.lastSuggestedProducts = [];
  }
}

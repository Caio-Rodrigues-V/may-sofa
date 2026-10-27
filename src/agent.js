import fs from 'node:fs';
import { config } from './config.js';
import { findCatalog, findCommercialRules, findKnowledge, findProductLinkKnowledge, logEvent, mediaUrl, normalize } from './supabase.js';
import { getSession, markHuman, nextRoundRobinUser, saveSession, withHandoffOperationLock } from './redis.js';
import { confirmTransferDestination, getWtsSession, isHumanOwned, sendInternalNote, sendMedia, sendText, sessionDepartmentId, sessionDepartmentName, sessionIsHumanOwned, transfer } from './wts.js';
import { addCardNoteOnce, addCardTag, assignResponsible, ensureCard, moveCard, updateDescription } from './crm.js';
import { applyAnswerProductsState, applyResolvedProductState, buildSearchQuery, detectIntent, isSupportRequest, mentionedProducts, requestedConfiguration, requestedWidth, resolveContextProduct, shouldShortCircuitHuman, updateLeadQualification } from './conversation.js';
import { compactCatalog, paymentChannelPolicy, resolveProductLink, resolveVariantOffer, shouldAllowLink } from './catalog.js';
import { executeRecoverableHandoff } from './handoff.js';
import { settleAgentDependencies } from './dependencies.js';
import { commercialClosingAction, isBusinessHours } from './business-hours.js';
import { deliverProductMedia, selectProductMedia } from './media.js';

const systemPrompt = fs.readFileSync(new URL('../SYSTEM-PROMPT.txt', import.meta.url), 'utf8');
const handoffPhrase = 'Vou encaminhar seu atendimento a um de nossos consultores com as informações que você compartilhou, para que ele possa continuar com as opções mais adequadas.';
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function formatMoney(value) {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function offerAnswer(offer) {
  const conditions = [];
  const policy = paymentChannelPolicy(offer.price.channel);
  const installmentsAllowed = policy.maxInstallments === null || Number(offer.price.installment_count) <= policy.maxInstallments;
  if (offer.price.installment_count && offer.price.installment_value !== null && installmentsAllowed) conditions.push(`${offer.price.installment_count}x de ${formatMoney(offer.price.installment_value)}`);
  if (offer.price.cash_price !== null) conditions.push(`${formatMoney(offer.price.cash_price)} à vista`);
  return `Para o sofá ${offer.product.name} com ${(offer.widthCm / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m, o valor é ${conditions.join(' ou ')}. Quer seguir com essa opção?`;
}

function catalogAlternativesAnswer(product, widthCm, catalog) {
  const alternatives = catalog.filter((item) => item.id !== product.id && normalize(item.product_type).includes('sofa')).slice(0, 3).map((item) => item.name);
  const width = (widthCm / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  if (alternatives.length === 0) return `O valor do ${product.name} com ${width} m depende da configuração escolhida. Você prefere um sofá retrátil, fixo ou com chaise?`;
  return `Para a medida de ${width} m, também posso te apresentar os modelos ${alternatives.join(', ')}. Qual deles você gostaria de conhecer melhor?`;
}

function ambiguousOfferAnswer(resolution) {
  const configurations = [...new Set(resolution.candidates.map((candidate) => candidate.variant.configuration || candidate.variant.label).filter(Boolean))];
  if (configurations.length > 1 && configurations.length <= 4) return `Essa medida possui mais de uma configuração para o ${resolution.product.name}: ${configurations.join(' ou ')}. Qual delas você prefere?`;
  return `Essa medida possui mais de uma configuração para o ${resolution.product.name}. Qual configuração você procura?`;
}

function mediaIntroduction(productName, mediaCount) {
  const quantity = mediaCount === 1 ? 'uma imagem' : 'algumas imagens';
  return `Separei ${quantity} de referência do modelo ${productName} para você conhecer melhor o design. As cores, os tecidos e a configuração mostrados podem variar e precisam ser confirmados.`;
}

function productsWithMedia(catalog, limit = 3) {
  return catalog.filter((product) => product.media?.length > 0).slice(0, limit);
}

function rememberSuggestedProducts(state, products) {
  state.lastSuggestedProducts = products.slice(0, 4).map((product) => ({ id: product.id, name: product.name }));
  if (products.length === 1) {
    state.currentProductId = products[0].id;
    state.currentProduct = products[0].name;
    return;
  }
  if (products.length > 1) {
    state.currentProductId = null;
    state.currentProduct = null;
    state.currentVariantId = null;
  }
}

function catalogSelectionAnswer(products) {
  const names = products.map((product) => product.name).join(', ');
  if (products.length === 1) return `Tenho o ${names} no catálogo. Quer que eu te mostre fotos ou veja as condições dele?`;
  return `Tenho opções no catálogo, como ${names}. Qual você quer ver primeiro?`;
}

function catalogMediaIntroduction(products) {
  const names = products.map((product) => product.name).join(', ');
  if (products.length === 1) return `Separei uma imagem de referência do ${names} para você conhecer melhor. Se gostar, me diga que eu sigo com as condições.`;
  return `Separei algumas imagens de referência dos modelos ${names}. Me diga qual chamou mais sua atenção para eu seguir com as condições.`;
}

function linkAnswer(product, link) {
  if (product && link?.url) return `Claro! Aqui está a página oficial do modelo ${product.name}: ${link.url}`;
  return `Claro! Aqui está o site oficial da Sofás May: ${config.storeSiteUrl}`;
}

function isGenericShippingQuestion(text) {
  return /\b(frete|entrega|prazo)\b/i.test(text)
    && !/\b\d{5}-?\d{3}\b/.test(text)
    && !/\b(valor exato|qual (?:e|é) o valor|quanto custa|quanto fica|meu cep|para o cep|fora do estado)\b/i.test(text);
}

async function complete(messages, context) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.openaiModel,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: `CONTEXTO E AÇÕES DEFINIDOS PELO BACKEND (fonte de verdade):\n${JSON.stringify(context)}` },
        ...messages.slice(-12),
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
  const body = await response.json();
  return body.choices?.[0]?.message?.content?.trim() || 'Um consultor confirmará essa informação.';
}

async function recordDecision(sessionId, to, data) {
  console.log(JSON.stringify({ level: 'info', event: 'agent_decision', sessionId, ...data }));
  await logEvent({ session_id: sessionId, contact_id: to, event_type: 'agent_decision', event_data: data });
}

function activeProductNames(state) {
  return [...new Set([state.currentProduct, ...state.lastSuggestedProducts.map((item) => item.name)].filter(Boolean))].slice(0, 5);
}

export async function performHandoff({ sessionId, to, name, state, history, card, reason, messageId }, overrides = {}) {
  const ops = {
    addCardNoteOnce,
    addCardTag,
    assignResponsible,
    moveCard,
    updateDescription,
    sendHandoffNote,
    saveSession,
    sendText,
    getWtsSession,
    transfer,
    confirmTransferDestination,
    markHuman,
    recordDecision,
    withHandoffOperationLock,
    pickNextCommercialUser: () => nextRoundRobinUser(config.wtsCommercialUserIds),
    ...overrides,
  };
  const products = activeProductNames(state);
  const departmentId = config.wtsCommercialDepartmentId;
  const assignedUserId = state.assignedUserId || await ops.pickNextCommercialUser();
  const assignedUserIndex = assignedUserId ? config.wtsCommercialUserIds.indexOf(assignedUserId) : -1;
  const assignedUserName = assignedUserIndex >= 0 ? config.wtsCommercialUserNames[assignedUserIndex] || null : null;
  const assignedAgentId = assignedUserIndex >= 0 ? config.wtsCommercialAgentIds[assignedUserIndex] || null : null;
  state.assignedTeamId = departmentId;
  state.assignedUserId = assignedUserId || null;
  state.assignedUserName = assignedUserName || null;
  const customerHandoffPhrase = handoffPhrase;
  const alreadyRecorded = history.some((item) => item.role === 'assistant' && item.content === customerHandoffPhrase);
  const handoffHistory = (alreadyRecorded ? history : [...history, { role: 'assistant', content: customerHandoffPhrase }]).slice(-12);
  const operationId = state.transfer.operationId || `${sessionId}:${messageId || 'handoff'}`;
  state.history = handoffHistory;
  console.log(JSON.stringify({ level: 'info', event: 'handoff_expected_team', sessionId, serviceType: state.serviceType, expectedTeamId: departmentId, assignedUserId, assignedUserName }));
  let result = null;
  const acquired = await ops.withHandoffOperationLock(operationId, async () => {
    result = await executeRecoverableHandoff({
      state,
      operationId,
      sessionId,
      to,
      name,
      reason,
      messageId,
      expectedTeamId: departmentId,
      persist: () => ops.saveSession(sessionId, state),
      prepareCrm: async () => {
        if (!card?.id) return;
        card = await ops.moveCard(card, 'consultant');
        await ops.updateDescription(card.id, buildCrmDescription(to, handoffHistory, products, state));
        if (assignedUserId) {
          try {
            await ops.assignResponsible(card.id, assignedUserId);
          } catch (err) {
            console.log(JSON.stringify({ level: 'warn', event: 'crm_assign_responsible_failed', cardId: card.id, assignedUserId, error: err.message }));
          }
        }
        if (state.supportRequested) {
          if (!state.supportTagApplied) {
            await ops.addCardTag(card.id, 'SUPORTE');
            state.supportTagApplied = true;
          }
          if (!state.supportNoteAdded) {
            await ops.addCardNoteOnce(card.id, buildSupportNote(name, products, state), '[SUPORTE]');
            state.supportNoteAdded = true;
          }
        }
        state.cardId = card.id;
      },
      sendNote: () => {
        console.log(JSON.stringify({ level: 'info', event: 'handoff_note_started', sessionId, serviceType: state.serviceType }));
        return ops.sendHandoffNote(sessionId, name, to, handoffHistory, products);
      },
      sendMessage: () => ops.sendText(sessionId, to, customerHandoffPhrase),
      checkDestination: async () => {
        const session = await ops.getWtsSession(sessionId);
        return { humanOwned: sessionIsHumanOwned(session), actualTeamId: sessionDepartmentId(session), actualTeamName: sessionDepartmentName(session) };
      },
      transferOwnership: () => {
        console.log(JSON.stringify({ level: 'info', event: 'handoff_requested_team', sessionId, serviceType: state.serviceType, requestedTeamId: departmentId, assignedUserId, assignedAgentId }));
        return ops.transfer(sessionId, departmentId, assignedUserId, assignedAgentId);
      },
      confirmDestination: async () => {
        const confirmation = await ops.confirmTransferDestination(sessionId, departmentId);
        console.log(JSON.stringify({ level: confirmation.matched ? 'info' : 'error', event: 'handoff_actual_team', sessionId, serviceType: state.serviceType, expectedTeamId: departmentId, actualTeamId: confirmation.actualTeamId, actualTeamName: confirmation.actualTeamName, matched: confirmation.matched }));
        return confirmation;
      },
      markHuman: () => ops.markHuman(sessionId, 'handoff'),
      record: () => ops.recordDecision(sessionId, to, { action: 'transfer', reason, service_type: state.serviceType, assigned_team_id: state.assignedTeamId, assigned_user_id: state.assignedUserId, product: state.currentProduct || null, width_cm: state.currentWidthCm }),
      onStatus: (status, error) => {
        const mismatch = error?.code === 'HANDOFF_DESTINATION_MISMATCH';
        const events = { already_human: 'handoff_already_human', note_failed: 'handoff_note_failed', note_success: 'handoff_note_success', failed: mismatch ? 'handoff_destination_mismatch' : 'handoff_retry_failed', completed: 'handoff_completed' };
        console.log(JSON.stringify({ level: error ? 'error' : 'info', event: events[status] || 'transfer_state', sessionId, serviceType: state.serviceType, transfer_status: status, operationId, attempt: state.transfer.attempts, expectedTeamId: state.transfer.expectedTeamId, requestedTeamId: state.transfer.requestedTeamId, actualTeamId: state.transfer.actualTeamId, actualTeamName: state.transfer.actualTeamName, error: error?.message }));
      },
    });
  });
  if (!acquired) {
    console.log(JSON.stringify({ level: 'info', event: 'handoff_lock_busy', sessionId, operationId }));
    return { busy: true };
  }
  console.log(JSON.stringify({ level: 'info', event: 'human_control_enabled', sessionId, expectedTeamId: state.transfer.expectedTeamId, actualTeamId: state.transfer.actualTeamId, assignedUserId: state.assignedUserId }));
  return result;
}

export async function recoverPendingHandoff(sessionId) {
  const state = await getSession(sessionId);
  const transferState = state.transfer;
  const needsRecovery = transferState.operationId && (!transferState.transferCompleted || !transferState.noteSent || !transferState.messageSent);
  if (!needsRecovery) return { skipped: true };
  console.log(JSON.stringify({ level: 'info', event: transferState.transferCompleted && !transferState.noteSent ? 'handoff_note_retry' : 'handoff_retry', operationId: transferState.operationId, sessionId, attempt: transferState.attempts + 1, status: transferState.status }));
  return performHandoff({
    sessionId,
    to: transferState.to,
    name: transferState.name,
    state,
    history: state.history,
    card: state.cardId ? { id: state.cardId } : null,
    reason: transferState.reason || 'handoff_recovery',
    messageId: transferState.messageId,
  });
}

export async function handleCustomerMessage({ sessionId, to, text, messageId, contactName }) {
  const state = await getSession(sessionId);
  const transferRecoverable = ['pending', 'failed'].includes(state.transfer.status);
  if (messageId && state.processedMessageIds.includes(messageId) && !transferRecoverable) return;
  if (shouldShortCircuitHuman(state, false)) return;

  const wtsSession = await getWtsSession(sessionId);
  const wtsOwned = sessionIsHumanOwned(wtsSession);
  if (shouldShortCircuitHuman(state, wtsOwned)) {
    if (wtsOwned && !state.humanControl) await markHuman(sessionId, 'wts_owner');
    return;
  }

  if (transferRecoverable) {
    await performHandoff({ sessionId, to, name: contactName, state, history: state.history, card: null, reason: state.transfer.reason || 'handoff_retry', messageId: state.transfer.operationId?.split(':').at(-1) || messageId });
    return;
  }

  const sessionData = wtsSession?.data || wtsSession || {};
  const contactId = sessionData.contactId || sessionData.contact?.id || sessionData.contactDetails?.id;
  const resolvedContactName = contactName || sessionData.contact?.name || sessionData.contactDetails?.name || sessionData.name;
  const firstContact = state.history.length === 0;
  state.serviceType = 'commercial';
  state.assignedTeamId = config.wtsCommercialDepartmentId;
  const supportRequested = isSupportRequest(text);
  if (supportRequested) {
    state.supportRequested = true;
    state.supportContext = text;
  }
  const previousAssistantMessage = [...state.history].reverse().find((item) => item.role === 'assistant')?.content || '';
  const intent = detectIntent(text, previousAssistantMessage);
  state.lastIntent = intent;
  updateLeadQualification(state, text, intent);
  const history = [...state.history, { role: 'user', content: text }].slice(-12);

  let card = null;
  if (contactId) {
    card = await ensureCard(contactId, resolvedContactName || to || 'Lead WhatsApp');
    if (card?.id) state.cardId = card.id;
  }

  if (supportRequested) {
    await performHandoff({ sessionId, to, name: resolvedContactName, state, history, card, reason: 'support_requested', messageId });
    return;
  }

  if (/^1[!. ]*$/.test(String(text).trim())) {
    const answer = 'Qual produto você gostaria de conhecer?';
    await sendText(sessionId, to, answer);
    state.history = [...history, { role: 'assistant', content: answer }].slice(-12);
    state.stage = 'discovery';
    await finalizeState({ state, sessionId, messageId, card, to, catalog: [], products: activeProductNames(state) });
    return;
  }

  if (['human_request', 'commercial_handoff'].includes(intent)) {
    await performHandoff({ sessionId, to, name: resolvedContactName, state, history, card, reason: intent, messageId });
    return;
  }

  const searchQuery = buildSearchQuery(state, text);
  const dependencies = await settleAgentDependencies(
    [() => findCatalog(searchQuery), () => findKnowledge(searchQuery), () => findCommercialRules()],
    (component, error) => console.error(JSON.stringify({ level: 'error', event: 'dependency_failed', dependency: 'supabase', component, status: 'failed', sessionId, error: error?.message })),
  );
  const { catalog, knowledge, commercialRules } = dependencies;
  console.log(JSON.stringify({ level: 'info', event: 'product_resolution_started', sessionId, query: text }));
  let productResolution;
  let stateChange;
  const widthResult = requestedWidth(text);
  const explicitWidth = widthResult.widthCm;
  try {
    productResolution = resolveContextProduct(catalog, text, state);
    stateChange = applyResolvedProductState(state, productResolution, widthResult);
    console.log(JSON.stringify({ level: productResolution.status === 'none' ? 'warn' : 'info', event: productResolution.status === 'none' ? 'product_resolution_failed' : 'product_resolution_success', sessionId, status: productResolution.status, productId: state.currentProductId || productResolution.product?.id || null, productName: state.currentProduct || productResolution.product?.name || null, variantId: state.currentVariantId || null }));
  } catch (error) {
    console.log(JSON.stringify({ level: 'error', event: 'product_resolution_failed', sessionId, error: error.message }));
    throw error;
  }
  if (stateChange.productChanged) console.log(JSON.stringify({ level: 'info', event: 'product_context_changed', sessionId, product_changed: true, width_reset: stateChange.widthReset }));
  if (widthResult.source) console.log(JSON.stringify({ level: 'info', event: 'width_resolution', sessionId, width_source: widthResult.source, width_cm: explicitWidth }));
  const currentProduct = productResolution.status === 'resolved' ? productResolution.product : null;
  const requestedConfig = requestedConfiguration(text);
  if (currentProduct && requestedConfig && state.currentWidthCm !== null) {
    const matchingVariants = currentProduct.variants.filter((variant) => {
      const applies = (variant.exact_width_cm !== null && Number(variant.exact_width_cm) === state.currentWidthCm)
        || (variant.exact_width_cm === null && variant.min_width_cm !== null && variant.max_width_cm !== null && state.currentWidthCm >= Number(variant.min_width_cm) && state.currentWidthCm <= Number(variant.max_width_cm));
      return applies && normalize(`${variant.configuration || ''} ${variant.label || ''}`).includes(requestedConfig);
    });
    if (matchingVariants.length === 1) state.currentVariantId = matchingVariants[0].id;
  }

  if (productResolution.status === 'ambiguous' && ['product_price', 'product_media', 'product_link', 'purchase_interest'].includes(intent)) {
    const names = productResolution.candidates.map((item) => item.name).filter(Boolean).slice(0, 4);
    const answer = `Qual modelo você quis dizer: ${names.join(', ')}?`;
    await sendText(sessionId, to, answer);
    state.history = [...history, { role: 'assistant', content: answer }].slice(-12);
    state.stage = 'product_selection';
    await finalizeState({ state, sessionId, messageId, card, to, catalog, products: names });
    return;
  }

  let answer = null;
  let offerResolution = null;
  let action = 'respond';

  if (!dependencies.availability.catalog) {
    answer = 'Não consegui confirmar as opções agora. Posso encaminhar você a um consultor para continuar o atendimento?';
    action = 'catalog_unavailable';
  }

  if (!answer && intent === 'product_price') {
    if (!currentProduct) {
      const suggestedProducts = catalog.slice(0, 4);
      if (suggestedProducts.length > 0) {
        rememberSuggestedProducts(state, suggestedProducts);
        state.stage = 'product_selection';
        answer = catalogSelectionAnswer(suggestedProducts);
        action = 'present_catalog_options';
      } else {
        answer = 'Qual modelo você gostaria de consultar?';
      }
    } else if (state.currentWidthCm === null) {
      answer = `Qual largura você deseja para o ${currentProduct.name}?`;
    } else {
      offerResolution = resolveVariantOffer(currentProduct, state.currentWidthCm, 'whatsapp', { variantId: state.currentVariantId });
      if (offerResolution.status === 'matched') {
        const channelPolicy = paymentChannelPolicy(offerResolution.price.channel);
        console.log(JSON.stringify({ level: 'info', event: 'price_channel', sessionId, productId: currentProduct.id, priceId: offerResolution.price.id, channel: channelPolicy.channel, maxInstallments: channelPolicy.maxInstallments }));
        state.currentVariantId = offerResolution.variant.id;
        state.stage = 'offer';
        answer = offerAnswer(offerResolution);
        state.lastPresentedOffer = {
          productId: currentProduct.id,
          product: currentProduct.name,
          variantId: offerResolution.variant.id,
          widthCm: state.currentWidthCm,
          priceId: offerResolution.price.id,
          channel: offerResolution.price.channel,
          cashPrice: offerResolution.price.cash_price,
          installmentCount: offerResolution.price.installment_count,
          installmentValue: offerResolution.price.installment_value,
          presentedAt: new Date().toISOString(),
        };
      } else if (offerResolution.status === 'ambiguous') {
        state.currentVariantId = null;
        state.stage = 'variant_selection';
        answer = ambiguousOfferAnswer(offerResolution);
        action = 'clarify_ambiguous_offer';
      } else {
        state.currentVariantId = null;
        answer = catalogAlternativesAnswer(currentProduct, state.currentWidthCm, catalog);
      }
      await recordDecision(sessionId, to, {
        intent,
        product: currentProduct.name,
        product_id: currentProduct.id,
        width_cm: state.currentWidthCm,
        variant: offerResolution.variant?.id || null,
        price: offerResolution.price?.id || null,
        channel: 'whatsapp',
        variant_resolution: offerResolution.status,
        candidates: offerResolution.candidates?.length || 0,
        action,
      });
    }
  }

  let productLinkKnowledge = [];
  if (currentProduct && !currentProduct.official_url) {
    try { productLinkKnowledge = await findProductLinkKnowledge(currentProduct); }
    catch (error) { console.error(JSON.stringify({ level: 'error', event: 'dependency_failed', dependency: 'supabase', component: 'product_link', status: 'failed', sessionId, error: error.message })); }
  }
  const productLink = resolveProductLink(currentProduct, productLinkKnowledge.length ? productLinkKnowledge : knowledge, commercialRules);
  const businessHours = isBusinessHours(new Date(), {
    timezone: config.storeTimezone,
    open: config.storeBusinessOpen,
    close: config.storeBusinessClose,
    days: config.storeBusinessDays,
  });
  const closingAction = commercialClosingAction({
    intent,
    offer: state.lastPresentedOffer,
    currentProductId: currentProduct?.id,
    siteOnly: Boolean(productLink.siteOnly && productLink.url),
    businessHours,
  });
  if (['closing_intent', 'offer_acceptance'].includes(intent)) {
    state.closingIntent = true;
    console.log(JSON.stringify({ level: 'info', event: 'closing_intent_detected', sessionId, productId: currentProduct?.id || null, priceId: state.lastPresentedOffer?.priceId || null, business_hours: businessHours }));
  }
  if (closingAction === 'site_only') {
    answer = linkAnswer(currentProduct, productLink);
  } else if (closingAction === 'handoff') {
    console.log(JSON.stringify({ level: 'info', event: 'commercial_handoff_started', sessionId, productId: currentProduct.id, priceId: state.lastPresentedOffer.priceId, business_hours: true }));
    await performHandoff({ sessionId, to, name: resolvedContactName, state, history, card, reason: 'commercial_closing', messageId });
    return;
  } else if (closingAction === 'after_hours_site') {
    const url = productLink.url || config.storeSiteUrl;
    state.afterHoursLead = true;
    state.consultantFollowUpPending = true;
    state.stage = 'commercial_followup';
    answer = `No momento, nosso atendimento comercial está fora do horário, mas você pode continuar pelo nosso site:\n\n${url}\n\nAssim que o atendimento comercial retornar, um consultor poderá continuar seu atendimento por aqui.`;
    console.log(JSON.stringify({ level: 'info', event: 'after_hours_site_sent', sessionId, productId: currentProduct.id, urlSource: productLink.url ? productLink.source : 'configured_store_site', priceChannel: state.lastPresentedOffer.channel }));
    console.log(JSON.stringify({ level: 'info', event: 'after_hours_followup_pending', sessionId, cardId: card?.id || null, business_hours: false }));
  }
  const allowLinks = shouldAllowLink({ explicitRequest: intent === 'product_link', purchaseIntent: intent === 'purchase_interest', link: productLink });
  if (!answer && allowLinks && currentProduct) answer = linkAnswer(currentProduct, productLink);
  if (!answer && intent === 'product_link') answer = linkAnswer(currentProduct, productLink);
  if (!answer && intent === 'shipping' && isGenericShippingQuestion(text)) answer = 'A entrega é feita por transporte próprio e o frete varia conforme a região e a distância. Qual é a cidade ou região da entrega para confirmar certinho?';

  let mediaDeliveries = [];
  if (!answer && intent === 'product_media') {
    if (!currentProduct && productsWithMedia(catalog).length > 0) {
      const suggestedProducts = productsWithMedia(catalog);
      rememberSuggestedProducts(state, suggestedProducts);
      state.stage = 'product_selection';
      mediaDeliveries = suggestedProducts
        .map((product) => ({ product, mediaItems: selectProductMedia(product, state).slice(0, 1) }))
        .filter((delivery) => delivery.mediaItems.length > 0);
      answer = mediaDeliveries.length > 0 ? catalogMediaIntroduction(mediaDeliveries.map((delivery) => delivery.product)) : catalogSelectionAnswer(suggestedProducts);
      console.log(JSON.stringify({ level: 'info', event: 'catalog_media_selected', sessionId, productIds: mediaDeliveries.map((delivery) => delivery.product.id), mediaCount: mediaDeliveries.reduce((sum, delivery) => sum + delivery.mediaItems.length, 0) }));
    } else if (!currentProduct && state.lastSuggestedProducts.length > 1) {
      answer = `Claro. De qual modelo você gostaria de ver as fotos: ${state.lastSuggestedProducts.map((item) => item.name).join(', ')}?`;
    } else if (!currentProduct) {
      const suggestedProducts = catalog.slice(0, 4);
      if (suggestedProducts.length > 0) {
        rememberSuggestedProducts(state, suggestedProducts);
        state.stage = 'product_selection';
        answer = catalogSelectionAnswer(suggestedProducts);
      } else {
        answer = 'Claro. De qual modelo você gostaria de ver as fotos?';
      }
    } else {
      console.log(JSON.stringify({ level: 'info', event: 'media_lookup_started', sessionId, productId: currentProduct.id, productName: currentProduct.name, variantId: state.currentVariantId }));
      try {
        const mediaToSend = selectProductMedia(currentProduct, state);
        mediaDeliveries = mediaToSend.length > 0 ? [{ product: currentProduct, mediaItems: mediaToSend }] : [];
        console.log(JSON.stringify({ level: mediaToSend.length ? 'info' : 'warn', event: mediaToSend.length ? 'media_lookup_success' : 'media_lookup_empty', sessionId, productId: currentProduct.id, productName: currentProduct.name, variantId: state.currentVariantId, mediaCount: mediaToSend.length, mediaIds: mediaToSend.map((media) => media.id) }));
      } catch (error) {
        console.log(JSON.stringify({ level: 'error', event: 'media_lookup_failed', sessionId, productId: currentProduct.id, productName: currentProduct.name, variantId: state.currentVariantId, error: error.message }));
        throw error;
      }
      const mediaToSend = mediaDeliveries.flatMap((delivery) => delivery.mediaItems);
      answer = mediaToSend.length > 0 ? mediaIntroduction(currentProduct.name, mediaToSend.length) : 'No momento, não tenho imagens desse modelo para enviar por aqui. Posso te apresentar outro modelo do catálogo.';
    }
  }

  if (!answer) {
    const actions = ['ASK_ONE_QUESTION', 'PRESENT_CATALOG_OPTIONS'];
    if (currentProduct?.media.length) actions.push('OFFER_MEDIA');
    if (allowLinks) actions.push('SEND_PRODUCT_LINK');
    const rawAnswer = await complete(history, {
      estado: {
        produto_atual: state.currentProduct,
        produto_atual_id: state.currentProductId,
        variante_atual_id: state.currentVariantId,
        ultima_medida_cm: state.currentWidthCm,
        ultimos_produtos_sugeridos: state.lastSuggestedProducts,
        intencao: intent,
        etapa: state.stage,
        controle_humano: state.humanControl,
        comercial: { business_hours: businessHours, closing_intent: state.closingIntent, after_hours_lead: state.afterHoursLead, consultant_follow_up_pending: state.consultantFollowUpPending },
      },
      cliente: { nome: resolvedContactName || null, periodo: greetingPeriod() },
      catalogo: compactCatalog(catalog),
      conhecimento: knowledge,
      acoes_permitidas: actions,
      links_permitidos: allowLinks ? [productLink.url] : [],
    });
    answer = allowLinks ? rawAnswer : removeLinks(rawAnswer);
  }

  answer = firstContact ? firstContactAnswer(text, resolvedContactName, answer) : answer;
  if (answer.includes('[[TRANSFERIR]]')) {
    state.processedMessageIds = [...state.processedMessageIds, messageId].filter(Boolean).slice(-100);
    await performHandoff({ sessionId, to, name: resolvedContactName, state, history, card, reason: 'legacy_agent_marker', messageId });
    return;
  }

  if (await isHumanOwned(sessionId)) { await markHuman(sessionId, 'wts_owner'); return; }
  if (state.delivery.messageId !== messageId) state.delivery = { messageId: messageId || null, textSent: false, sentMediaIds: [] };
  await saveSession(sessionId, state);
  if (!state.delivery.textSent) {
    await sendText(sessionId, to, answer);
    state.delivery.textSent = true;
    await saveSession(sessionId, state);
  }
  if (mediaDeliveries.length && !await isHumanOwned(sessionId)) {
    for (const delivery of mediaDeliveries) {
      await deliverProductMedia({
        sessionId, to, product: delivery.product, knowledge, mediaItems: delivery.mediaItems, state,
        send: sendMedia, resolveUrl: mediaUrl, persist: saveSession, pause: wait,
        onFailure: (error, media) => console.log(JSON.stringify({ level: 'error', event: 'media_send_failed', sessionId, productId: delivery.product.id, productName: delivery.product.name, variantId: state.currentVariantId, mediaId: media.id, mimeType: media.mime_type || null, error: error.message })),
      });
    }
  }

  const answerProducts = mentionedProducts(catalog, answer);
  applyAnswerProductsState(state, answerProducts);
  state.history = [...history, { role: 'assistant', content: answer }].slice(-12);
  state.stage = state.stage === 'discovery' && catalog.length > 0 ? 'qualification' : state.stage;
  await finalizeState({ state, sessionId, messageId, card, to, catalog, products: activeProductNames(state) });
}

async function finalizeState({ state, sessionId, messageId, card, to, catalog, products }) {
  state.processedMessageIds = [...state.processedMessageIds, messageId].filter(Boolean).slice(-100);
  state.products = [...new Set(products)].slice(0, 10);
  if (card?.id) {
    card = await moveCard(card, catalog.length > 0 ? 'qualified' : 'inService');
    state.cardId = card.id;
    await updateDescription(card.id, buildCrmDescription(to, state.history, state.products, state));
  }
  await saveSession(sessionId, state);
}

function greetingPeriod() {
  const hour = Number(new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()));
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

export function firstContactAnswer(text, fullName, generated) {
  const firstName = String(fullName || '').trim().split(/\s+/)[0];
  const usableName = firstName && !/^\+?\d+$/.test(firstName) ? `, ${firstName}` : '';
  const greeting = `${greetingPeriod()}${usableName}! Sou a May, assistente virtual da Sofás May.`;
  const compact = normalize(text).replace(/\s+/g, '');
  if (/^(?:oi+|ola+|oal|bomdia|boatarde|boanoite|eai|hey)$/.test(compact)) return `${greeting} Como posso te ajudar?`;
  const withoutRepeatedGreeting = String(generated || '')
    .replace(/^(?:ol[aá]|oi|bom dia|boa tarde|boa noite)[,! ]*/i, '')
    .replace(/^(?:eu\s+)?sou\s+(?:a\s+)?(?:may[,]?\s+)?assistente\s+virtual\s+da\s+sof[aá]s\s+may[.!,: ]*/i, '')
    .trim();
  return withoutRepeatedGreeting ? `${greeting}\n\n${withoutRepeatedGreeting}` : `${greeting} Como posso te ajudar?`;
}

function buildCrmDescription(phone, history, products, state = null) {
  const conversation = history.slice(-10).map((item) => `${item.role === 'user' ? 'Cliente' : 'Assistente'}: ${item.content}`).join('\n');
  return ['Lead recebido pelo WhatsApp da Sofás May.', `Telefone: ${phone || 'não identificado'}`, products.length ? `Produtos de interesse: ${products.join(', ')}` : 'Produto de interesse: ainda não identificado', state ? '' : null, state ? 'Dados da oportunidade:' : null, state ? structuredHandoffSummary(state) : null, '', 'Resumo da conversa:', conversation].filter((item) => item !== null).join('\n');
}

function structuredHandoffSummary(state) {
  const offer = state.lastPresentedOffer?.productId === state.currentProductId ? state.lastPresentedOffer : null;
  const rows = [
    state.currentProduct && `Produto: ${state.currentProduct}`,
    state.currentWidthCm !== null && `Medida: ${(state.currentWidthCm / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} m`,
    state.currentVariantId && `Variante: ${state.currentVariantId}`,
    offer?.cashPrice !== null && offer?.cashPrice !== undefined && `Preço à vista apresentado: ${formatMoney(offer.cashPrice)}`,
    offer?.installmentCount && offer?.installmentValue && `Parcelamento apresentado: ${offer.installmentCount}x de ${formatMoney(offer.installmentValue)}`,
    state.assignedUserName && `Consultor atribuído: ${state.assignedUserName}`,
    state.assignedUserId && `ID Consultor: ${state.assignedUserId}`,
  ].filter(Boolean);
  return rows.length ? rows.join('\n') : 'Sem dados adicionais estruturados.';
}

function buildSupportNote(name, products, state) {
  const context = state.supportContext ? `Mensagem do cliente: "${state.supportContext}"` : 'Cliente solicitou atendimento de suporte/pós-venda.';
  return [`[SUPORTE] Cliente: ${name || 'Não informado'}`, `Produtos: ${products.join(', ') || 'Não especificado'}`, context, 'Encaminhado para a equipe de atendimento.'].join('\n');
}

function removeLinks(text) {
  return String(text || '').replace(/https?:\/\/[^\s)\]}>,"']+/gi, '').replace(/\s{2,}/g, ' ').trim();
}

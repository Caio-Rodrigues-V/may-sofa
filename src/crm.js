import { config } from './config.js';

const stageRank = { newLead: 0, inService: 1, qualified: 2, consultant: 3 };
const stepToStage = Object.fromEntries(Object.entries(config.crmSteps).map(([stage, id]) => [id, stage]));

async function request(path, options = {}) {
  const response = await fetch(`${config.wtsBaseUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${config.wtsToken}`, 'Content-Type': 'application/*+json', ...options.headers },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`CRM ${response.status}: ${text}`);
  if (!text.trim()) return null;
  try { return JSON.parse(text); } catch { return text; }
}

export async function findCard(contactId) {
  const query = new URLSearchParams({ PanelId: config.crmPanelId, ContactId: contactId, PageSize: '20' });
  const body = await request(`/crm/v1/panel/card?${query}`);
  return (body?.items || []).find((card) => !card.archived) || null;
}

export async function createCard(contactId, title) {
  const body = await request('/crm/v1/panel/card', {
    method: 'POST',
    body: JSON.stringify({ stepId: config.crmSteps.newLead, title, contactIds: [contactId] }),
  });
  return body?.data || body;
}

export async function ensureCard(contactId, title) {
  const existing = await findCard(contactId);
  if (existing) return existing;
  return createCard(contactId, title);
}

export async function getCard(cardId) {
  return request(`/crm/v1/panel/card/${cardId}`);
}

function cardTagNames(card) {
  const values = card?.tagNames || card?.tags || [];
  return values.map((tag) => typeof tag === 'string' ? tag : tag?.name).filter(Boolean);
}

export async function addCardTag(cardId, tagName) {
  const card = await getCard(cardId);
  const existing = cardTagNames(card?.data || card);
  if (existing.some((name) => name.toLocaleUpperCase('pt-BR') === tagName.toLocaleUpperCase('pt-BR'))) return { added: false };
  await request(`/crm/v2/panel/card/${cardId}`, {
    method: 'PUT',
    body: JSON.stringify({ fields: ['TagNames'], tagNames: [...existing, tagName] }),
  });
  return { added: true };
}

export async function addCardNoteOnce(cardId, text, marker = '[SUPORTE]') {
  const notes = await request(`/crm/v1/panel/card/${cardId}/note?PageNumber=1&PageSize=100`);
  const items = notes?.items || notes?.data?.items || [];
  if (items.some((note) => String(note?.text || '').includes(marker))) return { added: false };
  await request(`/crm/v1/panel/card/${cardId}/note`, { method: 'POST', body: JSON.stringify({ text }) });
  return { added: true };
}

export async function moveCard(card, targetStage) {
  const currentStage = stepToStage[card?.stepId];
  if (currentStage && stageRank[currentStage] >= stageRank[targetStage]) return card;
  const stepId = config.crmSteps[targetStage];
  await request(`/crm/v2/panel/card/${card.id}`, { method: 'PUT', body: JSON.stringify({ fields: ['StepId'], stepId }) });
  return { ...card, stepId };
}

export async function updateDescription(cardId, description) {
  await request(`/crm/v2/panel/card/${cardId}`, {
    method: 'PUT',
    body: JSON.stringify({ fields: ['Description'], description: description.slice(0, 4000) }),
  });
}

export async function assignResponsible(cardId, responsibleUserId) {
  if (!cardId || !responsibleUserId) return { skipped: true };
  await request('/crm/v2/panel/card/' + cardId, {
    method: 'PUT',
    body: JSON.stringify({ fields: ['ResponsibleUserId'], responsibleUserId }),
  });
  return { assigned: true, responsibleUserId };
}

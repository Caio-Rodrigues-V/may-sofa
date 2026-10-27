import { config } from './config.js';

async function request(path, options = {}) {
  const { observeResponse, ...fetchOptions } = options;
  const response = await fetch(`${config.wtsBaseUrl}${path}`, { ...fetchOptions, headers: { Authorization: `Bearer ${config.wtsToken}`, 'Content-Type': 'application/json', ...fetchOptions.headers } });
  const text = await response.text();
  let parsed = null;
  if (text.trim()) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  observeResponse?.({ status: response.status, ok: response.ok, body: parsed });
  if (!response.ok) throw new Error(`WTS ${response.status}: ${text}`);
  return parsed;
}
export async function getWtsSession(id) { return request(`/chat/v1/session/${encodeURIComponent(id)}`); }
export function sessionDepartmentId(sessionResponse) {
  const session = sessionResponse?.data || sessionResponse || {};
  return session.departmentId || session.department?.id || session.departmentDetails?.id || null;
}
export function sessionDepartmentName(sessionResponse) {
  const session = sessionResponse?.data || sessionResponse || {};
  return session.departmentDetails?.name || session.department?.name || null;
}
export async function getWtsContact(id) { return request(`/core/v1/contact/${encodeURIComponent(id)}`); }
export async function getLatestCustomerMessage(id) {
  const query = new URLSearchParams({ PageSize: '30', OrderBy: 'createdAt', OrderDirection: 'DESCENDING' });
  const body = await request(`/chat/v1/session/${encodeURIComponent(id)}/message?${query}`);
  const items = Array.isArray(body) ? body.flat(Infinity) : (body?.items || []).flat(Infinity);
  return items.find((message) => message?.direction === 'FROM_HUB' && message?.origin === 'GATEWAY' && message?.text?.trim()) || null;
}
export function sessionIsHumanOwned(sessionResponse) {
  const session = sessionResponse?.data || sessionResponse || {};
  const hasUser = Boolean(session.userId);
  const status = String(session.status || '').toUpperCase();
  if (!hasUser) return false;
  if (!status) return true;
  return status !== 'PENDING';
}
export async function isHumanOwned(id) { return sessionIsHumanOwned(await getWtsSession(id)); }
export async function sendText(id, to, text) {
  if (await isHumanOwned(id)) return { blocked: 'human_owned' };
  const cleanTo = String(to || '').replace(/\D/g, '');
  const cleanFrom = String(config.wtsFrom || '').replace(/\D/g, '');
  return request('/chat/v1/message/send', {
    method: 'POST',
    body: JSON.stringify({ from: cleanFrom || config.wtsFrom, to: cleanTo || to, body: { text } }),
  });
}
function safeMediaOrigin(fileUrl) {
  try { const url = new URL(fileUrl); return `${url.origin}${url.pathname}`; } catch { return 'invalid_url'; }
}
export async function sendMedia(id, to, fileUrl, text = '', metadata = {}) {
  const details = { sessionId: id, mediaId: metadata.mediaId || null, productId: metadata.productId || null, mimeType: metadata.mimeType || null, source: safeMediaOrigin(fileUrl) };
  console.log(JSON.stringify({ level: 'info', event: 'media_send_started', ...details }));
  try {
    if (await isHumanOwned(id)) throw new Error('media_send_blocked_human_owned');
    const cleanTo = String(to || '').replace(/\D/g, '');
    const cleanFrom = String(config.wtsFrom || '').replace(/\D/g, '');
    return await request('/chat/v1/message/send', {
      method: 'POST',
      body: JSON.stringify({ from: cleanFrom || config.wtsFrom, to: cleanTo || to, body: { fileUrl, text } }),
      observeResponse: ({ status, ok, body }) => console.log(JSON.stringify({ level: ok ? 'info' : 'error', event: ok ? 'media_send_success' : 'media_send_failed', ...details, httpStatus: status, responseId: body?.id || null })),
    });
  } catch (error) {
    console.log(JSON.stringify({ level: 'error', event: 'media_send_failed', ...details, error: error.message }));
    throw error;
  }
}
export async function sendInternalNote(id, text) {
  return request(`/chat/v1/session/${encodeURIComponent(id)}/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/*+json' },
    body: JSON.stringify({ text }),
  });
}
export async function transfer(id, departmentId = config.wtsCommercialDepartmentId, userId = null, agentId = null) {
  const endpoint = '/chat/v1/session/' + encodeURIComponent(id) + '/transfer';
  console.log(JSON.stringify({ level: 'info', event: 'wts_transfer_started', sessionId: id, method: 'PUT', endpoint }));
  console.log(JSON.stringify({ level: 'info', event: 'wts_transfer_team_id', sessionId: id, teamId: departmentId, userId, agentId }));
  const attempts = userId
    ? [
        { label: 'user_direct', body: { type: 'USER', newDepartmentId: departmentId, newUserId: userId, userId, options: { stopBotInExecution: true } } },
        { label: 'department_with_user', body: { type: 'DEPARTMENT', newDepartmentId: departmentId, newUserId: userId, userId, options: { stopBotInExecution: true } } },
        { label: 'department_fallback', body: { type: 'DEPARTMENT', newDepartmentId: departmentId, options: { stopBotInExecution: true } } },
      ]
    : [{ label: 'department', body: { type: 'DEPARTMENT', newDepartmentId: departmentId, options: { stopBotInExecution: true } } }];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      console.log(JSON.stringify({ level: 'info', event: 'wts_transfer_attempt', sessionId: id, mode: attempt.label, teamId: departmentId, userId, agentId }));
      return await request(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/*+json' },
        body: JSON.stringify(attempt.body),
        observeResponse: ({ status, ok, body }) => {
          const session = body?.data || body || {};
          console.log(JSON.stringify({ level: ok ? 'info' : 'error', event: 'wts_transfer_http_status', sessionId: id, mode: attempt.label, status, ok }));
          console.log(JSON.stringify({ level: ok ? 'info' : 'error', event: 'wts_transfer_response', sessionId: id, status: session.status || null, departmentId: session.departmentId || session.departmentDetails?.id || null, departmentName: session.departmentDetails?.name || session.department?.name || null, userId: session.userId || null }));
        },
      });
    } catch (error) {
      lastError = error;
      console.log(JSON.stringify({ level: attempt.label === 'department_fallback' ? 'error' : 'warn', event: 'wts_transfer_attempt_failed', sessionId: id, mode: attempt.label, teamId: departmentId, userId, agentId, error: error.message }));
    }
  }
  console.log(JSON.stringify({ level: 'error', event: 'wts_transfer_failed', sessionId: id, teamId: departmentId, userId, agentId, error: lastError?.message }));
  throw lastError;
}

export async function confirmTransferDestination(id, expectedTeamId, { attempts = 6, delayMs = 500 } = {}) {
  let actualTeamId = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const session = await getWtsSession(id);
    actualTeamId = sessionDepartmentId(session);
    if (actualTeamId === expectedTeamId) return { matched: true, actualTeamId, actualTeamName: sessionDepartmentName(session), session };
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { matched: false, actualTeamId, actualTeamName: null };
}
export function isHumanOutbound(payload) {
  const message = payload?.lastMessage || payload?.message || payload?.data?.lastMessage || payload?.data?.message || payload?.data || payload;
  const direction = message?.direction || payload?.direction;
  const origin = String(message?.origin || payload?.origin || '').toUpperCase();
  return direction === 'TO_HUB' && !['API', 'BOT', 'AUTOMATION', 'SYSTEM', 'OPENAI'].includes(origin);
}

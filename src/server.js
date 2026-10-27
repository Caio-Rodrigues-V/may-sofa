import http from 'node:http';
import { assertIsolatedConfiguration, config, dependencyStatus } from './config.js';
import { ensureRedis, listRecoverableHandoffs, markHuman, withSessionLock } from './redis.js';
import { handleCustomerMessage, recoverPendingHandoff } from './agent.js';
import { startHandoffRecovery, stopHandoffRecovery } from './handoff-recovery.js';
import { getLatestCustomerMessage, getWtsContact, getWtsSession, isHumanOutbound } from './wts.js';

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}
function authorized(request, url) {
  const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  return Boolean(config.webhookSecret) && (bearer === config.webhookSecret || url.searchParams.get('token') === config.webhookSecret);
}
async function readJson(request) {
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > 1_000_000) throw new Error('payload_too_large'); }
  return body ? JSON.parse(body) : {};
}
function eventFields(payload) {
  const message = payload.lastMessage || payload.message || payload.data?.lastMessage || payload.data?.message || payload.data || payload;
  return {
    sessionId: String(payload.sessionId || payload.session?.id || message.sessionId || message.session?.id || payload.content?.sessionId || payload.data?.sessionId || payload.variables?.sessionId || payload.variables?.session_id || ''),
    to: String(message.from || payload.from || payload.contact?.phone || payload.contact?.phonenumber || ''),
    text: String(message.body?.text || message.text || payload.text || '').trim(),
    direction: message.direction || payload.direction,
    messageId: String(message.id || payload.messageId || ''),
  };
}

async function normalizeEvent(payload) {
  const event = eventFields(payload);
  if (!event.sessionId) return event;
  if (event.text && event.to) return event;
  const session = await getWtsSession(event.sessionId);
  const sessionData = session?.data || session || {};
  const contactId = sessionData.contactId || sessionData.contact?.id;
  const [contact, latest] = await Promise.all([
    contactId ? getWtsContact(contactId) : null,
    getLatestCustomerMessage(event.sessionId),
  ]);
  return {
    ...event,
    to: event.to || String(contact?.phonenumber || contact?.phoneNumber || ''),
    text: event.text || String(latest?.text || '').trim(),
    direction: event.direction || latest?.direction || 'FROM_HUB',
    messageId: event.messageId || String(latest?.id || ''),
    contactName: String(contact?.name || ''),
  };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, { status: 'ok', agent: 'sofas-may', enabled: config.enabled, promptVersion: config.promptVersion }); return;
    }
    if (request.method === 'GET' && url.pathname === '/ready') {
      const dependencies = dependencyStatus();
      const ready = config.enabled && Object.values(dependencies).every(Boolean);
      json(response, ready ? 200 : 503, { status: ready ? 'ready' : 'setup_pending', enabled: config.enabled, dependencies }); return;
    }
    if (request.method === 'POST' && url.pathname === '/webhook/wts') {
      if (!authorized(request, url)) { json(response, 401, { error: 'unauthorized' }); return; }
      const payload = await readJson(request);
      if (!config.enabled) { json(response, 503, { error: 'agent_disabled', status: 'setup_pending' }); return; }
      console.log(JSON.stringify({ level: 'info', event: 'webhook_received', bodyKeys: Object.keys(payload) }));
      const event = await normalizeEvent(payload);
      if (!event.sessionId) { console.warn(JSON.stringify({ level: 'warn', event: 'webhook_rejected', reason: 'missing_session_id' })); json(response, 400, { error: 'missing_session_id' }); return; }
      if (isHumanOutbound(payload)) { await markHuman(event.sessionId, 'human_outbound'); json(response, 202, { status: 'human_takeover_recorded' }); return; }
      if (event.direction && event.direction !== 'FROM_HUB') { json(response, 202, { status: 'ignored' }); return; }
      if (!event.text || !event.to) { console.warn(JSON.stringify({ level: 'warn', event: 'webhook_rejected', reason: 'missing_message_or_contact', sessionId: event.sessionId })); json(response, 202, { status: 'ignored' }); return; }
      json(response, 202, { status: 'accepted' });
      void withSessionLock(event.sessionId, () => handleCustomerMessage(event))
        .then((handled) => { if (!handled) console.error(JSON.stringify({ level: 'error', event: 'session_lock_timeout', sessionId: event.sessionId })); })
        .catch((error) => console.error(JSON.stringify({ level: 'error', event: 'message_failed', sessionId: event.sessionId, error: error.message })));
      return;
    }
    json(response, 404, { error: 'not_found' });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'request_failed', error: error.message }));
    if (!response.headersSent) json(response, 400, { error: 'invalid_request' });
  }
});

await ensureRedis();
if (config.enabled) {
  startHandoffRecovery({
    listDue: () => listRecoverableHandoffs(),
    recover: recoverPendingHandoff,
    log: (event, data) => console.log(JSON.stringify({ level: event.endsWith('failed') ? 'error' : 'info', event, ...data })),
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stopHandoffRecovery());
assertIsolatedConfiguration();
server.listen(config.port, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', event: 'agent_started', agent: 'sofas-may', enabled: config.enabled, port: config.port })));

import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { normalizeSessionState } from './conversation.js';

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: true });
const key = (suffix) => `${config.redisPrefix}${suffix}`;
const handoffPendingKey = key('handoff:pending');
export async function ensureRedis() { if (redis.status === 'wait') await redis.connect(); return redis.ping(); }
export async function getSession(id) { const raw = await redis.get(key(`session:${id}`)); return normalizeSessionState(raw ? JSON.parse(raw) : {}); }
export async function saveSession(id, value) {
  const state = normalizeSessionState(value);
  const needsRecovery = state.transfer.operationId && (!state.transfer.transferCompleted || !state.transfer.noteSent || !state.transfer.messageSent);
  const transaction = redis.multi().set(key(`session:${id}`), JSON.stringify(state), 'EX', config.sessionTtl);
  if (needsRecovery) transaction.zadd(handoffPendingKey, Date.parse(state.transfer.nextRetryAt || new Date().toISOString()), id);
  else transaction.zrem(handoffPendingKey, id);
  await transaction.exec();
}
export async function markHuman(id, reason = 'unknown') { const state = await getSession(id); state.human = true; state.humanControl = true; state.humanReason = reason; state.history = state.history.slice(-12); await saveSession(id, state); }
export async function releaseHumanControl(id) { const state = await getSession(id); state.human = false; state.humanControl = false; state.humanReason = null; await saveSession(id, state); return state; }
export async function listRecoverableHandoffs(now = Date.now(), limit = 20) { return redis.zrangebyscore(handoffPendingKey, '-inf', now, 'LIMIT', 0, limit); }
export async function withHandoffOperationLock(operationId, work) {
  const lockKey = key(`handoff:lock:${operationId}`); const token = randomUUID();
  if (!await redis.set(lockKey, token, 'PX', 60000, 'NX')) return false;
  try { await work(); } finally { if (await redis.get(lockKey) === token) await redis.del(lockKey); }
  return true;
}
export async function withSessionLock(id, work) {
  const lockKey = key(`lock:${id}`); const token = randomUUID();
  const deadline = Date.now() + 120000;
  while (!await redis.set(lockKey, token, 'PX', 120000, 'NX')) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try { await work(); } finally { if (await redis.get(lockKey) === token) await redis.del(lockKey); }
  return true;
}

export async function nextRoundRobinUser(users, suffix = 'round-robin:commercial') {
  const cleanUsers = users.filter(Boolean);
  if (!cleanUsers.length) return null;
  const index = await redis.incr(key(suffix));
  return cleanUsers[(index - 1) % cleanUsers.length];
}

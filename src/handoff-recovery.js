let timer = null;

export async function runHandoffRecoveryOnce({ listDue, recover, log = () => {} }) {
  const sessionIds = await listDue();
  if (sessionIds.length) log('handoff_recovery_found', { count: sessionIds.length });
  for (const sessionId of sessionIds) {
    try { await recover(sessionId); log('handoff_retry_success', { sessionId }); }
    catch (error) { log('handoff_retry_failed', { sessionId, error: error.message }); }
  }
  return sessionIds.length;
}

export function startHandoffRecovery(dependencies, intervalMs = 5000) {
  if (timer) return timer;
  dependencies.log?.('handoff_recovery_started', {});
  const run = () => runHandoffRecoveryOnce(dependencies).catch((error) => dependencies.log?.('handoff_retry_failed', { error: error.message }));
  void run();
  timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}

export function stopHandoffRecovery() {
  if (timer) clearInterval(timer);
  timer = null;
}

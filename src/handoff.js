export function handoffBackoffMs(attempt) {
  return [0, 5000, 15000, 30000, 60000][Math.min(Math.max(attempt - 1, 0), 4)];
}

export async function executeRecoverableHandoff({ state, operationId, sessionId, to, name, reason, messageId, expectedTeamId, persist, prepareCrm, sendNote, sendMessage, checkDestination = null, checkHumanOwnership = async () => false, transferOwnership, confirmDestination = async () => ({ matched: true, actualTeamId: expectedTeamId || null }), markHuman, record, onStatus = () => {} }) {
  const now = Date.now();
  state.transfer = {
    ...state.transfer,
    status: 'pending', operationId, sessionId, to, name, messageId, reason, attempts: state.transfer.attempts + 1,
    requestedAt: state.transfer.requestedAt || new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    nextRetryAt: new Date(now + handoffBackoffMs(state.transfer.attempts + 1)).toISOString(), lastError: null,
  };
  state.transferRequested = true;
  state.stage = 'handoff';
  state.transfer.expectedTeamId = expectedTeamId || state.transfer.expectedTeamId || null;
  state.transfer.requestedTeamId = expectedTeamId || state.transfer.requestedTeamId || null;
  await persist();
  onStatus('pending', null);

  const warnings = [];
  const currentDestination = checkDestination
    ? await checkDestination()
    : { humanOwned: await checkHumanOwnership(), actualTeamId: state.transfer.expectedTeamId };
  state.transfer.actualTeamId = currentDestination.actualTeamId || null;
  state.transfer.actualTeamName = currentDestination.actualTeamName || null;
  if (currentDestination.humanOwned && currentDestination.actualTeamId === state.transfer.expectedTeamId && !state.transfer.transferCompleted) {
    state.transfer.transferCompleted = true;
    state.transfer.messageSent = true;
    await persist();
    onStatus('already_human', null);
  }
  if (!state.transfer.crmPrepared) {
    try { await prepareCrm(); state.transfer.crmPrepared = true; await persist(); }
    catch (error) { warnings.push(`crm:${error.message}`); }
  }
  if (!state.transfer.noteSent) {
    try { await sendNote(); state.transfer.noteSent = true; await persist(); onStatus('note_success', null); }
    catch (error) { warnings.push(`note:${error.message}`); onStatus('note_failed', error); }
  }
  if (!state.transfer.messageSent) {
    try { await sendMessage(); state.transfer.messageSent = true; await persist(); }
    catch (error) { warnings.push(`message:${error.message}`); }
  }
  if (!state.transfer.transferCompleted) {
    try {
      const transferResponse = await transferOwnership();
      const confirmation = await confirmDestination();
      confirmation.actualTeamName ||= transferResponse?.departmentDetails?.name || transferResponse?.department?.name || null;
      state.transfer.actualTeamId = confirmation.actualTeamId || null;
      state.transfer.actualTeamName = confirmation.actualTeamName || null;
      if (!confirmation.matched) {
        const error = new Error(`WTS destination mismatch: expected ${state.transfer.expectedTeamId}, received ${state.transfer.actualTeamId || 'unknown'}`);
        error.code = 'HANDOFF_DESTINATION_MISMATCH';
        throw error;
      }
      state.transfer.transferCompleted = true;
      await persist();
    } catch (error) {
      state.transfer.status = 'failed';
      state.transfer.lastError = error.message;
      state.transfer.updatedAt = new Date().toISOString();
      state.transfer.nextRetryAt = new Date(Date.now() + handoffBackoffMs(state.transfer.attempts + 1)).toISOString();
      await persist();
      onStatus('failed', error);
      throw error;
    }
  }

  state.transfer.status = 'completed';
  state.transfer.completedAt = new Date().toISOString();
  state.transfer.updatedAt = state.transfer.completedAt;
  state.transfer.nextRetryAt = (!state.transfer.noteSent || !state.transfer.messageSent)
    ? new Date(Date.now() + handoffBackoffMs(state.transfer.attempts + 1)).toISOString()
    : null;
  state.transfer.lastError = warnings.join('; ') || null;
  state.processedMessageIds = [...new Set([...state.processedMessageIds, messageId].filter(Boolean))].slice(-100);
  await persist();
  await markHuman();
  onStatus('completed', null);
  try { await record(); } catch (error) { warnings.push(`event:${error.message}`); }
  return { warnings };
}

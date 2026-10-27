export const config = {
  port: Number(process.env.PORT || 3000),
  enabled: String(process.env.AGENT_ENABLED || 'false').toLowerCase() === 'true',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  promptVersion: process.env.PROMPT_VERSION || 'sofas-may-v1',
  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  openaiEmbeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  redisUrl: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'redis'}:${process.env.REDIS_PORT || 6379}/${process.env.REDIS_DB || 0}`,
  sessionTtl: Number(process.env.REDIS_SESSION_TTL || 604800),
  wtsBaseUrl: (process.env.WTS_BASE_URL || 'https://api.wts.chat').replace(/\/$/, ''),
  wtsToken: process.env.WTS_TOKEN || '',
  wtsFrom: process.env.WTS_FROM || '',
  wtsDepartmentId: process.env.WTS_DEPARTMENT_ID || '',
  wtsCommercialDepartmentId: process.env.WTS_COMMERCIAL_DEPARTMENT_ID || process.env.WTS_DEPARTMENT_ID || '',
  wtsCommercialUserIds: String(process.env.WTS_COMMERCIAL_USER_IDS || '').split(',').map((value) => value.trim()).filter(Boolean),
  wtsCommercialUserNames: String(process.env.WTS_COMMERCIAL_USER_NAMES || '').split(',').map((value) => value.trim()).filter(Boolean),
  wtsCommercialAgentIds: String(process.env.WTS_COMMERCIAL_AGENT_IDS || '').split(',').map((value) => value.trim()).filter(Boolean),
  wtsPostSaleDepartmentId: process.env.WTS_POST_SALE_DEPARTMENT_ID || '',
  crmPanelId: process.env.CRM_PANEL_ID || '',
  crmSteps: {
    newLead: process.env.CRM_STEP_NEW_LEAD_ID || '',
    inService: process.env.CRM_STEP_IN_SERVICE_ID || '',
    qualified: process.env.CRM_STEP_QUALIFIED_ID || '',
    consultant: process.env.CRM_STEP_CONSULTANT_ID || '',
  },
  supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  tablePrefix: process.env.SUPABASE_TABLE_PREFIX || 'sofas_may_',
  redisPrefix: process.env.REDIS_KEY_PREFIX || 'sofas-may:',
  catalogBucket: process.env.SUPABASE_CATALOG_BUCKET || 'sofas-may-catalog',
  storeTimezone: process.env.STORE_TIMEZONE || 'America/Sao_Paulo',
  storeBusinessOpen: process.env.STORE_BUSINESS_OPEN || '09:00',
  storeBusinessClose: process.env.STORE_BUSINESS_CLOSE || '19:00',
  storeBusinessDays: String(process.env.STORE_BUSINESS_DAYS || '1,2,3,4,5,6').split(',').map(Number).filter(Number.isInteger),
  storeSiteUrl: process.env.STORE_SITE_URL || 'https://sofasmay.com.br',
};

export function assertIsolatedConfiguration() {
  const violations = [];
  if (!config.redisPrefix.startsWith('sofas-may:')) violations.push('REDIS_KEY_PREFIX');
  if (!config.tablePrefix.startsWith('sofas_may_')) violations.push('SUPABASE_TABLE_PREFIX');
  if (!config.catalogBucket.startsWith('sofas-may-')) violations.push('SUPABASE_CATALOG_BUCKET');
  const previousTenantPattern = new RegExp(['fonte', '(?:-|_|do)?', 'sofa'].join(''), 'i');
  if (previousTenantPattern.test(`${config.redisPrefix} ${config.tablePrefix} ${config.catalogBucket} ${config.storeSiteUrl}`)) violations.push('previous tenant reference');
  if (violations.length) throw new Error(`Unsafe Sofas May isolation configuration: ${violations.join(', ')}`);
}

export function dependencyStatus() {
  return {
    wts: Boolean(config.wtsToken && config.wtsFrom),
    transfer: Boolean(config.wtsCommercialDepartmentId),
    roundRobin: config.wtsCommercialUserIds.length > 0,
    crm: Boolean(config.crmPanelId && Object.values(config.crmSteps).every(Boolean)),
    supabase: Boolean(config.supabaseUrl && config.supabaseKey),
    openai: Boolean(config.openaiKey),
    redis: Boolean(config.redisUrl),
  };
}

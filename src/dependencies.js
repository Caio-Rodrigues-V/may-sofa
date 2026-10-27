export async function settleAgentDependencies(loaders, onFailure = () => {}) {
  const names = ['catalog', 'knowledge', 'commercial_rules'];
  const results = await Promise.allSettled(loaders.map((loader) => loader()));
  results.forEach((result, index) => { if (result.status === 'rejected') onFailure(names[index], result.reason); });
  return {
    catalog: results[0].status === 'fulfilled' ? results[0].value : [],
    knowledge: results[1].status === 'fulfilled' ? results[1].value : [],
    commercialRules: results[2].status === 'fulfilled' ? results[2].value : [],
    availability: Object.fromEntries(results.map((result, index) => [names[index], result.status === 'fulfilled'])),
  };
}

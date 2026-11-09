'use strict';

/**
 * Shared model/provider attribution used by ROI exports, agentq, and the
 * orchestrator. Keeping this policy outside a CLI module prevents dependency
 * cycles and makes routing behavior testable without loading export code.
 */

function stripAgentPrefix(model, fallbackAgent = '') {
  const raw = String(model || '');
  const match = raw.match(/^\[([^\]]+)\]\s*(.*)$/);
  return match
    ? { agent: fallbackAgent || match[1], model: match[2] }
    : { agent: fallbackAgent, model: raw };
}

function normalizeProviderName(provider) {
  const value = String(provider || '').toLowerCase();
  if (value === 'opencode-go' || value === 'opencode') return 'opencodego';
  if (value === 'openai-codex') return 'codex';
  if (value === 'cline-pass') return 'cline-pass';
  return value;
}

function attributePath(config, model, agent = '') {
  const { agent: prefixedAgent, model: stripped } = stripAgentPrefix(model, agent);
  const patterns = config.modelPathPatterns || {};
  const agentPatterns = patterns[prefixedAgent] || [];
  for (const pattern of agentPatterns) {
    if (stripped.includes(pattern.match)) {
      return { pathId: pattern.path, source: `model-pattern:${prefixedAgent}:${pattern.match}` };
    }
  }
  for (const patternsForAgent of Object.values(patterns)) {
    for (const pattern of patternsForAgent) {
      if (stripped.includes(pattern.match)) {
        return { pathId: pattern.path, source: `model-pattern:any:${pattern.match}` };
      }
    }
  }

  const providers = config.providerPathMap || {};
  const leadingProvider = normalizeProviderName(stripped.split('/')[0]);
  if (providers[leadingProvider]) {
    return { pathId: providers[leadingProvider], source: `provider:${leadingProvider}` };
  }

  // Provider clues can be embedded in routed model strings such as
  // accounts/fireworks/routers/... or aliases such as umans-foo.
  for (const [provider, pathId] of Object.entries(providers)) {
    const normalized = normalizeProviderName(provider);
    if (stripped.toLowerCase().includes(`${normalized}/`) || stripped.toLowerCase().startsWith(`${normalized}-`)) {
      return { pathId, source: `provider:${provider}` };
    }
  }

  const fallbackPath = config.agentPathMap?.[prefixedAgent];
  if (fallbackPath) return { pathId: fallbackPath, source: `agent:${prefixedAgent}` };
  return { pathId: '', source: 'unknown' };
}

module.exports = { stripAgentPrefix, normalizeProviderName, attributePath };

#!/usr/bin/env node
'use strict';
const { observeLiveQuota } = require('../src/lib/capacity-live-quota.js');

async function withHelperDeadline(work, { timeoutMs = 24000 } = {}) {
  // This process only reads usage. Its own deadline must survive cancellation
  // of the parent; provider timers may stop after receiving HTTP headers.
  const timer = setTimeout(() => process.exit(1), timeoutMs);
  try { return await work(); }
  finally { clearTimeout(timer); }
}

async function main() {
  return withHelperDeadline(async () => {
    const [go, openference, auth] = await Promise.all([
      import('@juanbenjumea/pi-provider-usage-fetcher/usage-api.ts'),
      import('@juanbenjumea/pi-provider-usage-fetcher/openference.ts'),
      import('@juanbenjumea/pi-provider-usage-fetcher/auth.ts'),
    ]);
    const output = await observeLiveQuota({ usage: { fetchUsageApi: go.fetchUsageApi, fetchOpenferenceUsage: openference.fetchOpenferenceUsage }, auth });
    await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(output), error => error ? reject(error) : resolve()));
  });
}
// End this dedicated read-only process even if an HTTP client retains handles.
if (require.main === module) main().then(() => process.exit(0), () => process.exit(1));
module.exports = { main, withHelperDeadline };

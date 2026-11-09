#!/usr/bin/env node
'use strict';

const { fetchCommandCodeQuotaEntry } = require('../src/lib/provider-usage.js');

async function main() {
  const result = await fetchCommandCodeQuotaEntry();
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(JSON.stringify({
    provider: 'commandcode',
    windows: result.windows,
    updatedAt: result.updatedAt,
  }, null, 2));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

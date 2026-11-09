#!/usr/bin/env node
'use strict';

const { fetchCursorQuotaEntry } = require('../src/lib/provider-usage.js');

async function main() {
  const result = await fetchCursorQuotaEntry();
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(JSON.stringify({
    provider: 'cursor',
    windows: result.windows,
    updatedAt: result.updatedAt,
  }, null, 2));
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

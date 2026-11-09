/**
 * Shared `--since` parsing for the collectors — one default date instead of the
 * same `'20260501'` literal copied into four files. ccusage accepts YYYYMMDD or
 * YYYY-MM-DD; we normalize to the dash-free form.
 *

/**
 * Effective default collection window. The hard-coded literal is the local
 * private-history start; set ROI_SINCE in the environment to override without
 * editing code.
 */
function defaultSince(env = process.env) {
  return env.ROI_SINCE || '20260501';
}

/** @param {string[]} argv  process.argv.slice(2). */
function parseSinceArg(argv, fallback = defaultSince()) {
  const i = argv.indexOf('--since');
  // `--since` as the last token (no value after it) is a scripting mistake;
  // fail loudly instead of silently falling back to the default date.
  if (i !== -1 && !argv[i + 1]) {
    throw new Error('--since flag provided but no value follows it. Expected YYYY-MM-DD or YYYYMMDD.');
  }
  const val = (i !== -1 && argv[i + 1]) ? argv[i + 1] : fallback;
  if (typeof val !== 'string') {
    throw new Error('Missing required argument: --since YYYY-MM-DD');
  }
  const clean = val.replace(/-/g, '');
  if (!/^\d{8}$/.test(clean)) {
    throw new Error(`Invalid date format for --since: "${val}". Expected YYYY-MM-DD or YYYYMMDD.`);
  }
  const y = parseInt(clean.slice(0, 4), 10);
  const m = parseInt(clean.slice(4, 6), 10);
  const d = parseInt(clean.slice(6, 8), 10);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (!(date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d)) {
    throw new Error(`Invalid date value for --since: "${val}".`);
  }
  return clean;
}

module.exports = { parseSinceArg, defaultSince };

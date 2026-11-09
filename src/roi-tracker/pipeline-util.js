'use strict';

/**
 * Tiny pure helpers shared by the pipeline modules.
 */

function parseDate8(raw) {
  const s = String(raw || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(s)) return null;
  const ms = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Number.isFinite(ms) ? ms : null;
}

function date8(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { parseDate8, date8, round2 };

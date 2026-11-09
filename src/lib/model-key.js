/**
 * Shared model-id normalization — the bridge across the naming schemes:
 *   xlsx slug   anthropic/claude-opus-4.8
 *   OpenRouter  anthropic/claude-opus-4.8-fast
 *   models.dev  <provider>/claude-opus-4-8
 *   ccusage     claude-opus-4-8  (bare)
 * All fold to the same key: drop the provider prefix, lowercase, dots/underscores
 * to dashes, strip trailing variant/date suffixes.
 */
function modelKey(id) {
  return String(id)
    .trim()
    .replace(/^\[pi\]\s*/i, '')
    .split('/').pop()
    .toLowerCase()
    // Strip parenthetical qualifiers first (gemini 3.6 flash (medium) → gemini 3.6 flash)
    .replace(/\([^)]*\)/g, '')
    // Normalize spaces and colons to dashes (gemini 3.6 flash → gemini-3-6-flash)
    .replace(/[._: ]+/g, '-')
    // Normalize Fireworks/Kimi naming: k2p6 → k2-6 (matches moonshotai/kimi-k2.6)
    .replace(/k2p(\d+)/g, 'k2-$1')
    // Strip trailing variant suffixes (including :free which becomes -free after colon→dash)
    .replace(/-(fast|beta|preview|free|turbo|latest|thinking|\d{8})$/, '')
    // Collapse multiple consecutive dashes and trim trailing dashes
    .replace(/--+/g, '-')
    .replace(/-+$/, '');
}

module.exports = { modelKey };

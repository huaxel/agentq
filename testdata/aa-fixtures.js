'use strict';
/**
 * Recorded-shape Artificial Analysis v2 language-model payloads.
 *
 * The shape (envelope, pagination, evaluations, cost, pricing, performance) is
 * copied from https://artificialanalysis.ai/data-api/docs/reference and from
 * gscripts/model-catalogs.gs. Every number here is invented: these fixtures
 * exist to pin the mapping and validation rules, not to record a real catalog.
 */

const CREATORS = {
  xai: { id: 'creator-xai', name: 'xAI' },
  anthropic: { id: 'creator-anthropic', name: 'Anthropic' },
  mistral: { id: 'creator-mistral', name: 'Mistral' },
};

const EMPTY_INDICES = {
  artificial_analysis_coding_index: null,
  artificial_analysis_agentic_index: null,
  artificial_analysis_finance_and_accounting_index: null,
  artificial_analysis_strategy_and_ops_index: null,
  artificial_analysis_legal_index: null,
  artificial_analysis_healthcare_and_medical_index: null,
  artificial_analysis_engineering_index: null,
  artificial_analysis_economics_index: null,
};

/** One Free-tier model record. */
function freeModel({
  id = 'id-grok-4-6',
  name = 'Grok 4.6',
  slug = 'grok-4-6',
  creator = CREATORS.xai,
  intelligence = 54,
  input = 2,
  output = 5,
  cacheHit = 0.2,
  speed = 96.4,
  evaluations = {},
} = {}) {
  return {
    id,
    name,
    slug,
    release_date: '2026-10-01',
    model_creator: creator,
    evaluations: { ...EMPTY_INDICES, artificial_analysis_intelligence_index: intelligence, ...evaluations },
    artificial_analysis_intelligence_index_cost: {
      total_cost: 1200.5,
      cost_per_task: { total_cost: 1.25 },
    },
    pricing: {
      price_1m_input_tokens: input,
      price_1m_output_tokens: output,
      price_1m_cache_hit_tokens: cacheHit,
      price_1m_cache_write_tokens: null,
    },
    performance: {
      median_output_tokens_per_second: speed,
      median_time_to_first_token_seconds: 1.1,
      median_time_to_first_answer_token_seconds: 20.2,
      median_end_to_end_response_time_seconds: 25.5,
    },
    performance_v3: {
      mean_output_tokens_per_second: 80.1,
      mean_time_to_first_token_seconds: 1.2,
      mean_time_to_first_answer_token_seconds: 21.3,
    },
  };
}

/** One page of the response envelope. */
function page(data, { page: number = 1, totalPages = 1, version = 4.1, tier = 'free' } = {}) {
  return {
    tier,
    intelligence_index_version: version,
    pagination: { page: number, page_size: 200, total_pages: totalPages, has_more: number < totalPages },
    data,
  };
}

/** Two Free pages: one model per target shape (slug match, name-only match). */
function freePages() {
  return [
    page([
      freeModel(),
      freeModel({
        id: 'id-sonnet-5-5',
        name: 'Claude Sonnet 5.5 (high)',
        slug: 'claude-sonnet-5-5',
        creator: CREATORS.anthropic,
        intelligence: 55,
        input: 3,
        output: 15,
        cacheHit: 0.3,
        speed: 84,
      }),
    ], { page: 1, totalPages: 2 }),
    page([
      freeModel({
        id: 'id-mistral-large-4',
        name: 'Mistral Large 4',
        slug: 'mistral-large-4',
        creator: CREATORS.mistral,
        intelligence: 41,
        input: 2,
        output: 6,
        cacheHit: null,
        speed: 70,
      }),
      // Slug does not fold to the target key; the display name does.
      freeModel({
        id: 'id-devstral',
        name: 'Devstral',
        slug: 'devstral-1-0',
        creator: CREATORS.mistral,
        intelligence: 33,
        input: 0.4,
        output: 2,
        cacheHit: 0.04,
        speed: 110,
      }),
    ], { page: 2, totalPages: 2 }),
  ];
}

/** One Pro page: per-benchmark evaluations as fractions. */
function proPage() {
  return page([
    freeModel({
      id: 'id-opus-5-5',
      name: 'Claude Opus 5.5 (max)',
      slug: 'claude-opus-5-5',
      creator: CREATORS.anthropic,
      intelligence: 59.1,
      input: 4,
      output: 20,
      cacheHit: 0.5,
      speed: 108.75,
      evaluations: {
        tau_banking: 0.503,
        terminalbench_v2_1: 0.839,
        scicode: 0.59,
        aa_lcr: 0.797,
        hle: 0.423,
        gpqa_diamond: 0.917,
        critpt: 0.191,
        gdpval_aa_elo: 1658,
        gdpval_aa_normalized: 0.579,
        aa_omniscience_index: 6.03,
        aa_omniscience_accuracy: 0.323,
      },
    }),
  ], { tier: 'pro' });
}

/**
 * A `-preview` variant and the released model both fold to the same model key
 * (modelKey strips `-preview`), so the exact slug must win.
 */
function previewPage() {
  return page([
    freeModel({ id: 'id-large-4-preview', name: 'Mistral Large 4 Preview', slug: 'mistral-large-4-preview', creator: CREATORS.mistral, input: 1, output: 3 }),
    freeModel({ id: 'id-large-4', name: 'Mistral Large 4 (High)', slug: 'mistral-large-4', creator: CREATORS.mistral, input: 2, output: 6 }),
  ]);
}

/**
 * A plain slug and a variant whose slug does not fold to the same model key, so
 * a registry `aaSlug` pin is the only thing that can select the variant.
 */
function pinnedPage() {
  return page([
    freeModel({ id: 'id-grok-4-6', name: 'Grok 4.6', slug: 'grok-4-6', input: 2, output: 5 }),
    freeModel({ id: 'id-grok-4-6-high', name: 'Grok 4.6 (High)', slug: 'grok-4-6-high', input: 3, output: 7 }),
  ]);
}

/** Two rows whose display names fold to one key but whose slugs do not. */
function nameTiePage() {
  return page([
    freeModel({ id: 'id-devstral-1', name: 'Devstral', slug: 'devstral-1-0' }),
    freeModel({ id: 'id-devstral-2', name: 'Devstral', slug: 'devstral-2-0' }),
  ]);
}

/** Two rows that fold to the same key and cannot be told apart. */
function ambiguousPage() {
  return page([
    freeModel({ id: 'id-grok-4-7-high', name: 'Grok 4.7 (high)', slug: 'grok-4-7' }),
    freeModel({ id: 'id-grok-4-7-max', name: 'Grok 4.7 (max)', slug: 'grok-4-7' }),
  ]);
}

module.exports = {
  CREATORS,
  freeModel,
  page,
  freePages,
  proPage,
  previewPage,
  pinnedPage,
  nameTiePage,
  ambiguousPage,
};

/** Google Sheets model catalogs: install this single file in a bound Apps Script project. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Model Catalogs")
    .addItem("Sync OpenRouter", "fetchOpenRouterModelsDetailed")
    .addItem("Sync Artificial Analysis", "fetchArtificialAnalysisData")
    .addToUi();
}

function catalogRun(label, sync) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getDocumentLock() || LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    throw new Error("Another catalog sync is running. Try again later.");
  }
  try {
    sync(spreadsheet, PropertiesService.getScriptProperties());
  } catch (error) {
    Logger.log(`${label} sync failed: ${error.message}`);
    spreadsheet.toast(`${label} sync failed: ${error.message}`);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function catalogFetchJson(url, headers, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = UrlFetchApp.fetch(url, {
      method: "get",
      headers,
      muteHttpExceptions: true,
    });
    const status = response.getResponseCode();
    if (status === 200) {
      let payload;
      try {
        payload = JSON.parse(response.getContentText());
      } catch (_error) {
        throw new Error(`${label}: invalid JSON response`);
      }
      if (!payload || !Array.isArray(payload.data)) {
        throw new Error(`${label}: expected a data array`);
      }
      return payload;
    }
    if ([429, 500, 502, 503, 504].includes(status) && attempt < 2) {
      const responseHeaders = response.getAllHeaders();
      const retryKey = Object.keys(responseHeaders).find(
        (key) => key.toLowerCase() === "retry-after",
      );
      const retryAfter = retryKey ? String(responseHeaders[retryKey]) : "";
      let delay = 1000 * 2 ** attempt;
      if (retryAfter) {
        delay = /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now();
        if (!Number.isFinite(delay)) delay = 1000 * 2 ** attempt;
        delay = Math.max(0, delay);
      }
      // Do not exceed Apps Script execution time or retry before a long cooldown.
      if (delay > 30000) {
        throw new Error(`${label}: HTTP ${status}; retry later after cooldown`);
      }
      Utilities.sleep(delay);
      continue;
    }
    const hint = {
      401: "check the API key in Script Properties",
      403: "check API access (Artificial Analysis Pro requires a Pro+ key)",
      410: "endpoint retired; update to a supported V2 endpoint",
      429: "rate limited; retry later",
    }[status];
    // Never echo an untrusted response body (which may contain credentials).
    throw new Error(`${label}: HTTP ${status}${hint ? `; ${hint}` : ""}`);
  }
}

function catalogNumber(value, scale = 1) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "number" && typeof value !== "string") return "";
  if (typeof value === "string" && !value.trim()) return "";
  const number = Number(value) * scale;
  return Number.isFinite(number) ? number : "";
}

function catalogList(value) {
  return Array.isArray(value) ? value.join(", ") : "";
}

function catalogCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  if (typeof value === "boolean") return value;
  const text = String(value).slice(0, 49000);
  // API strings must never become spreadsheet formulas.
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function catalogWrite(spreadsheet, name, headers, rows) {
  if (!rows.length) throw new Error("No models returned; existing sheet unchanged");
  const values = [headers, ...rows].map((row) => row.map(catalogCell));
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  const oldRows = sheet.getLastRow();
  const oldColumns = sheet.getLastColumn();
  if (sheet.getMaxRows() < values.length) {
    sheet.insertRowsAfter(sheet.getMaxRows(), values.length - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  // Write first: fetch/validation failures never clear the previous snapshot.
  sheet.getRange(1, 1, values.length, headers.length).setValues(values);
  if (oldRows > values.length) {
    sheet.getRange(values.length + 1, 1, oldRows - values.length, Math.max(oldColumns, headers.length)).clearContent();
  }
  if (oldColumns > headers.length) {
    sheet.getRange(1, headers.length + 1, values.length, oldColumns - headers.length).clearContent();
  }
  sheet.getRange(1, 1, 1, headers.length)
    .setFontWeight("bold").setBackground("#090d16").setFontColor("#f1f5f9");
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);
  return sheet;
}

/** Public OpenRouter catalog; optional OPENROUTER_API_KEY Script Property. */
function fetchOpenRouterModelsDetailed() {
  catalogRun("OpenRouter", (spreadsheet, properties) => {
    const headers = { Accept: "application/json" };
    const apiKey = (properties.getProperty("OPENROUTER_API_KEY") || "").trim();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const payload = catalogFetchJson(
      "https://openrouter.ai/api/v1/models?output_modalities=all&sort=most-popular",
      headers, "OpenRouter",
    );
    const columns = [
      "Model ID", "Canonical Slug", "Model Name", "Release Date",
      "Context Window", "Max Output Tokens", "Prompt Price ($/1M)",
      "Completion Price ($/1M)", "Cache Read ($/1M)", "Cache Write ($/1M)",
      "Web Search ($/call)", "Tiered Pricing Overrides (JSON; USD/token)",
      "AA Intelligence Index", "AA Coding Index", "AA Agentic Index",
      "Reasoning Mode", "Supported Efforts", "Input Modalities",
      "Output Modalities", "Tokenizer", "Moderated", "Supported Parameters", "Description",
    ];
    const seen = new Set();
    const rows = payload.data.map((model) => {
      if (!model || typeof model.id !== "string" || !model.id || seen.has(model.id)) {
        throw new Error("Missing or duplicate OpenRouter model ID");
      }
      seen.add(model.id);
      const architecture = model.architecture || {};
      const pricing = model.pricing || {};
      const provider = model.top_provider || {};
      const benchmark = model.benchmarks?.artificial_analysis || {};
      const reasoning = model.reasoning;
      let reasoningMode = "None";
      if (reasoning) {
        const effort = reasoning.default_effort ?? "auto";
        reasoningMode = reasoning.mandatory
          ? `Mandatory (Default: ${effort})`
          : reasoning.default_enabled
            ? `Default Enabled (Default: ${effort})` : "Optional";
      }
      let createdDate = "";
      if (typeof model.created === "number" && Number.isFinite(model.created)) {
        const date = new Date(model.created * 1000);
        if (!Number.isNaN(date.getTime())) {
          createdDate = Utilities.formatDate(date, "UTC", "yyyy-MM-dd");
        }
      }
      return [
        model.id, model.canonical_slug ?? "", model.name ?? "", createdDate,
        catalogNumber(model.context_length), catalogNumber(provider.max_completion_tokens),
        catalogNumber(pricing.prompt, 1000000), catalogNumber(pricing.completion, 1000000),
        catalogNumber(pricing.input_cache_read, 1000000),
        catalogNumber(pricing.input_cache_write, 1000000), catalogNumber(pricing.web_search),
        // Preserve inclusive thresholds, time windows, cache prices and inheritance.
        Array.isArray(pricing.overrides) ? JSON.stringify(pricing.overrides) : "",
        catalogNumber(benchmark.intelligence_index), catalogNumber(benchmark.coding_index),
        catalogNumber(benchmark.agentic_index), reasoningMode,
        catalogList(reasoning?.supported_efforts), catalogList(architecture.input_modalities),
        catalogList(architecture.output_modalities), architecture.tokenizer ?? "",
        typeof provider.is_moderated === "boolean" ? (provider.is_moderated ? "Yes" : "No") : "",
        catalogList(model.supported_parameters),
        String(model.description ?? "").replace(/[\r\n]+/g, " ").slice(0, 300),
      ];
    });
    const sheet = catalogWrite(spreadsheet, "OR_fetch", columns, rows);
    sheet.getRange(2, 5, rows.length, 2).setNumberFormat("#,##0");
    sheet.getRange(2, 7, rows.length, 4).setNumberFormat("$#,##0.0000");
    sheet.getRange(2, 11, rows.length, 1).setNumberFormat("$#,##0.0000");
    sheet.getRange(2, 13, rows.length, 3).setNumberFormat("0.0");
    spreadsheet.toast(`Synced ${rows.length} OpenRouter models`);
  });
}

/** Supported V2 language catalog. Free by default; Pro is explicit opt-in. */
function fetchArtificialAnalysisData() {
  catalogRun("Artificial Analysis", (spreadsheet, properties) => {
    const apiKey = (properties.getProperty("AA_API_KEY") || "").trim();
    if (!apiKey) throw new Error("Set AA_API_KEY in Script Properties");
    const access = (properties.getProperty("AA_ACCESS") || "free").trim().toLowerCase();
    if (!["free", "pro"].includes(access)) {
      throw new Error("AA_ACCESS must be free or pro");
    }
    const endpoint = "https://artificialanalysis.ai/api/v2/language/models" +
      (access === "free" ? "/free" : "");
    const models = [];
    const seen = new Set();
    let indexVersion;
    let totalPages;
    // Bound pagination so a broken server cannot exhaust Apps Script runtime.
    for (let page = 1; page <= 100; page++) {
      const payload = catalogFetchJson(`${endpoint}?page=${page}`, {
        "x-api-key": apiKey,
        Accept: "application/json",
      }, `Artificial Analysis page ${page}`);
      const pagination = payload.pagination;
      if (!pagination || pagination.page !== page ||
          !Number.isInteger(pagination.total_pages) || pagination.total_pages < page ||
          typeof pagination.has_more !== "boolean" ||
          pagination.has_more !== (page < pagination.total_pages)) {
        throw new Error(`Invalid pagination on page ${page}; existing sheet unchanged`);
      }
      if (page === 1) {
        indexVersion = payload.intelligence_index_version;
        totalPages = pagination.total_pages;
        if (typeof indexVersion !== "number" || !Number.isFinite(indexVersion)) {
          throw new Error("Missing Intelligence Index version");
        }
        if (totalPages > 100) throw new Error("Catalog exceeds 100-page safety limit");
      } else if (payload.intelligence_index_version !== indexVersion || pagination.total_pages !== totalPages) {
        throw new Error("Catalog changed during pagination; retry sync");
      }
      if (pagination.has_more && !payload.data.length) {
        throw new Error("Empty intermediate page; existing sheet unchanged");
      }
      for (const model of payload.data) {
        if (!model || typeof model.id !== "string" || !model.id || seen.has(model.id)) {
          throw new Error("Missing or duplicate model ID; retry sync");
        }
        seen.add(model.id);
        models.push(model);
      }
      if (!pagination.has_more) break;
      Utilities.sleep(150);
    }

    const headers = [
      "Model Name", "Creator", "Slug", "Release Date", "Intelligence Index",
      "Coding Index", "Agentic Index", "Cost Per Task ($)",
      "Price / 1M Input ($)", "Price / 1M Output ($)",
      "Price / 1M Cache Hit ($)", "Price / 1M Cache Write ($)",
      "Median Output Tokens/s", "Time to First Token (s)",
      "Time to First Answer Token (s)", "End-to-End Response Time (s)",
      "Model ID", "Intelligence Index Version", "Total Evaluation Cost ($)",
    ];
    const rows = models.map((item) => {
      const evaluations = item.evaluations || {};
      const pricing = item.pricing || {};
      const performance = item.performance || {};
      const cost = item.artificial_analysis_intelligence_index_cost || {};
      return [
        item.name ?? "", item.model_creator?.name ?? "", item.slug ?? "", item.release_date ?? "",
        catalogNumber(evaluations.artificial_analysis_intelligence_index),
        catalogNumber(evaluations.artificial_analysis_coding_index),
        catalogNumber(evaluations.artificial_analysis_agentic_index),
        // total_cost is the entire evaluation, NOT a per-task fallback.
        catalogNumber(cost.cost_per_task?.total_cost),
        catalogNumber(pricing.price_1m_input_tokens),
        catalogNumber(pricing.price_1m_output_tokens),
        catalogNumber(pricing.price_1m_cache_hit_tokens),
        catalogNumber(pricing.price_1m_cache_write_tokens),
        catalogNumber(performance.median_output_tokens_per_second),
        catalogNumber(performance.median_time_to_first_token_seconds),
        catalogNumber(performance.median_time_to_first_answer_token_seconds),
        catalogNumber(performance.median_end_to_end_response_time_seconds),
        item.id, indexVersion, catalogNumber(cost.total_cost),
      ];
    });
    const sheet = catalogWrite(spreadsheet, "AA_fetch", headers, rows);
    sheet.getRange(2, 5, rows.length, 3).setNumberFormat("0.0");
    sheet.getRange(2, 8, rows.length, 5).setNumberFormat("$#,##0.0000");
    sheet.getRange(2, 13, rows.length, 4).setNumberFormat("0.000");
    sheet.getRange(2, 18, rows.length, 1).setNumberFormat("0.0#");
    sheet.getRange(2, 19, rows.length, 1).setNumberFormat("$#,##0.0000");
    spreadsheet.toast(`Synced ${rows.length} Artificial Analysis models (${access}, Index v${indexVersion})`);
  });
}

#!/usr/bin/env node
'use strict';

/**
 * Minimal Jules REST API client.
 *
 * Uses the global fetch (Node >=18). Auth is read from JULES_API_KEY.
 * All functions return parsed JSON and throw on non-2xx responses.
 */

const API_BASE = process.env.JULES_API_BASE || 'https://jules.googleapis.com/v1alpha';

function apiKey() {
  const key = process.env.JULES_API_KEY;
  if (!key) throw new Error('JULES_API_KEY environment variable is required');
  return key;
}

async function julesRequest(path, { method = 'GET', body } = {}) {
  const url = `${API_BASE}${path}`;
  const headers = { 'x-goog-api-key': apiKey() };
  if (body != null) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`Jules API ${method} ${url} failed: ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function listSources() {
  const data = await julesRequest('/sources');
  return data.sources || [];
}

async function createSession({ source, prompt, baseBranch = 'main', title, automationMode, requirePlanApproval = null }) {
  const body = {
    prompt,
    sourceContext: {
      source,
      githubRepoContext: { startingBranch: baseBranch },
    },
  };
  if (automationMode != null) body.automationMode = automationMode;
  if (title != null) body.title = title;
  if (requirePlanApproval != null) body.requirePlanApproval = requirePlanApproval;
  return julesRequest('/sessions', { method: 'POST', body });
}

async function getSession(id) {
  return julesRequest(`/sessions/${id}`);
}

async function listActivities(id, { pageSize = 30 } = {}) {
  return julesRequest(`/sessions/${id}/activities?pageSize=${pageSize}`);
}

async function approvePlan(id) {
  return julesRequest(`/sessions/${id}:approvePlan`, { method: 'POST', body: {} });
}

async function sendMessage(id, prompt) {
  return julesRequest(`/sessions/${id}:sendMessage`, { method: 'POST', body: { prompt } });
}

module.exports = {
  API_BASE,
  listSources,
  createSession,
  getSession,
  listActivities,
  approvePlan,
  sendMessage,
};

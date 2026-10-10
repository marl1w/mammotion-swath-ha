/**
 * The activity list: mower state changes and errors over the last day, from Home
 * Assistant's own history, with bursts of the same error folded into one line.
 */

import { MOWER_STATES, explainError } from "./format.js";

const DAY_MS = 24 * 3600 * 1000;
const BURST_MS = 15 * 60 * 1000;
const MAX_ITEMS = 12;
const IGNORED = new Set(["unavailable", "unknown", ""]);

/** Fetch the raw history for the entities the list is built from. */
export async function fetchHistory(hass, entityIds) {
  const ids = entityIds.filter(Boolean);
  if (!ids.length) return {};
  return hass.callWS({
    type: "history/history_during_period",
    start_time: new Date(Date.now() - DAY_MS).toISOString(),
    entity_ids: ids,
    minimal_response: false,
    no_attributes: true,
    significant_changes_only: false,
  });
}

const changes = (history, entityId) =>
  (history[entityId] || []).map((row) => ({ state: row.s, at: new Date((row.lu ?? row.lc) * 1000) }));

/** The value of a changes list as of *at* (allowing for sensors updating a moment late). */
const valueAt = (list, at, slackMs = 10000) =>
  list.filter((c) => c.at.getTime() <= at.getTime() + slackMs).pop()?.state;

/** Turn history into newest-first activity items: {at, kind, title, detail, count}. */
export function buildActivity(history, { lawnMower, errorCode, errorMessage, errorTime }) {
  const items = [];

  let previous = null;
  for (const { state, at } of changes(history, lawnMower)) {
    if (IGNORED.has(state) || state === previous) continue;
    previous = state;
    items.push({ at, kind: "state", title: MOWER_STATES[state] || state, detail: null, count: 1 });
  }

  // The error *time* changes on every error, even when the same code repeats — a mower
  // retrying a dock sends one code eight times and the code sensor never changes state.
  const codes = changes(history, errorCode).filter((c) => !IGNORED.has(c.state));
  const messages = changes(history, errorMessage).filter((m) => !IGNORED.has(m.state));
  const times = changes(history, errorTime).filter((t) => !IGNORED.has(t.state));
  const sources = times.length ? times : codes;
  let lastKey = null;
  for (const { state, at } of sources) {
    const when = times.length && !Number.isNaN(Date.parse(state)) ? new Date(state) : at;
    const code = times.length ? valueAt(codes, at) : state;
    if (!code || `${state}` === lastKey) continue;
    lastKey = `${state}`;
    const { title, detail } = explainError(code, valueAt(messages, at));
    items.push({ at: when, kind: "error", code, title, detail, count: 1 });
  }

  items.sort((a, b) => b.at - a.at);

  // A mower retrying sends the same code many times; one line with a count reads better.
  const folded = [];
  for (const item of items) {
    const last = folded[folded.length - 1];
    if (last && item.kind === "error" && last.kind === "error" && last.code === item.code && last.at - item.at < BURST_MS) {
      last.count += 1;
      last.firstAt = item.at;
      continue;
    }
    folded.push({ ...item });
  }
  return folded.slice(0, MAX_ITEMS);
}

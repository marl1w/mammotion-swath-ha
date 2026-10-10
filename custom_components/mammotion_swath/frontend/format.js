/**
 * Small formatting helpers and the error explanations Mammotion's own table lacks.
 */

/** Mammotion schedules number weekdays from Sunday = 1, like Java's Calendar. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatWeeks(weeks) {
  const days = (weeks || []).filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (!days.length) return "No days set";
  if (days.length === 7) return "Every day";
  return days.map((d) => WEEKDAYS[d - 1]).join(", ");
}

export function formatTime(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatRelativeMinutes(target, now = new Date()) {
  const minutes = Math.round((target - now) / 60000);
  if (minutes < 0) return null;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${minutes % 60} min`;
}

export function formatArea(value) {
  return Number.isFinite(value) ? `${Math.round(value)} m²` : "—";
}

/**
 * Codes the mower sends that Mammotion's error table does not describe. Their wording is
 * what the mower's behaviour shows, and it says so: these are not official meanings.
 */
const UNDOCUMENTED = {
  11135: "Couldn't dock. The code is missing from Mammotion's list; it sits next to 11136, “failed to return to the charging station”, and comes in bursts while the mower retries.",
  5004: "Undocumented code, missing from Mammotion's list.",
};

const NOT_FOUND = /error message not found/i;

/** Return a readable line for an error code and the integration's own message. */
export function explainError(code, message) {
  const n = Math.abs(parseInt(code, 10));
  if (message && !NOT_FOUND.test(message)) {
    // Upstream messages read "module: Title, Advice". The title is what matters here.
    const text = message.replace(/^[a-z_]+:\s*/i, "");
    const [title, ...rest] = text.split(/,\s*(?=[A-Z0-9])/);
    return { title: title.trim(), detail: rest.join(", ").trim() || null };
  }
  if (UNDOCUMENTED[n]) return { title: `Code ${n}`, detail: UNDOCUMENTED[n] };
  return { title: `Code ${n}`, detail: "Not in Mammotion's error list." };
}

export const MOWER_STATES = {
  mowing: "Mowing",
  paused: "Paused",
  returning: "Returning to dock",
  docked: "Docked",
  error: "Error",
  unavailable: "Unavailable",
};

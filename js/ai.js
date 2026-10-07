/**
 * Optional AI assist: turn free-text availability notes into structured rules.
 *
 * The scheduler itself is entirely deterministic and never calls a model. This
 * module exists only for data entry - it reads the kind of note you'd actually
 * jot down or get sent in a message:
 *
 *   Sarah can only do Saturdays
 *   Tom's away 5-9 June
 *   don't put Rachel and Kate on together
 *
 * and proposes structured edits (weekday patterns, blackout dates, clash pairs)
 * which are shown for approval before anything is saved. The model never
 * decides who works when; it only reads English.
 *
 * Every result is validated against the organisation's real people, so a name
 * the model invents is dropped rather than written to your data.
 *
 * The API key is stored on this device only and is sent directly from the
 * browser to the provider - it never passes through any server of ours,
 * because there isn't one.
 */

/** Providers this app can call directly from a browser. */
export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  anthropic: {
    label: 'Anthropic Claude',
    defaultModel: 'claude-haiku-4-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
};

const PROMPT = `You convert free-text staff availability notes into JSON. \
Output JSON only - no prose, no code fence.

The people are exactly: {names}
Never invent a name that is not in that list.
The roster period is {start} to {end}.

Schema:
{
  "people": [
    {"name": "<exact name from the list>",
     "weekdays": [0-6, Monday=0, omit if the note says nothing about weekdays],
     "blackouts": [{"start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "reason": "..."}]
    }
  ],
  "clashes": [["<name>", "<name>"]]
}

Rules:
- "weekdays" is the FULL set of days that person can work, not a diff.
- A single unavailable day is a blackout with start == end.
- Resolve relative dates against the roster period above; assume its year.
- Only include a person if the note actually says something about them.
- "clashes" is for pairs who must not work the same shift.

Notes to convert:
{text}`;

/** Raised when the provider call fails or returns something unusable. */
export class AIError extends Error {}

/** Pull the JSON object out of a model reply, tolerating code fences. */
function extractJSON(text) {
  let body = text.trim();
  const fence = body.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) body = fence[1];
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) throw new AIError('The model did not return any JSON.');
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    throw new AIError(`The model returned malformed JSON: ${err.message}`);
  }
}

/**
 * POST the prompt to one provider and return the raw reply text.
 * Each provider wants a different envelope; the prompt itself is identical.
 */
async function call(provider, model, apiKey, prompt) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new AIError(`Unknown AI provider '${provider}'.`);
  model = model || spec.defaultModel;

  let url, headers, payload;
  if (provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
    payload = { contents: [{ parts: [{ text: prompt }] }] };
  } else if (provider === 'anthropic') {
    url = 'https://api.anthropic.com/v1/messages';
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      // Anthropic blocks browser calls unless this opt-in header is present.
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    payload = { model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] };
  } else {
    url = 'https://api.openai.com/v1/chat/completions';
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    payload = { model, messages: [{ role: 'user', content: prompt }] };
  }

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (err) {
    throw new AIError(
      `Could not reach ${spec.label}. Check the connection - this step needs internet, ` +
      `even though the rest of the app doesn't.`
    );
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new AIError(`${spec.label} returned ${res.status}: ${detail}`);
  }

  const data = await res.json();
  try {
    if (provider === 'gemini') return data.candidates[0].content.parts[0].text;
    if (provider === 'anthropic') return data.content[0].text;
    return data.choices[0].message.content;
  } catch {
    throw new AIError(`Unexpected reply from ${spec.label}.`);
  }
}

/**
 * Drop anything the model got wrong: unknown names, bad dates, bad weekdays.
 *
 * A model that hallucinates is a nuisance, not a data-integrity problem, so the
 * policy is to discard invalid entries rather than fail the whole parse - the
 * user reviews the proposed changes before they are applied.
 */
function validate(data, names) {
  const canon = new Map(names.map((n) => [n.toLowerCase(), n]));
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  const people = [];

  for (const entry of data.people || []) {
    if (!entry || typeof entry !== 'object') continue;
    const name = canon.get(String(entry.name || '').trim().toLowerCase());
    if (!name) continue;

    const clean = { name };

    // Weekdays: keep only real 0-6 indices, and only if some survived.
    if (Array.isArray(entry.weekdays)) {
      const days = [...new Set(entry.weekdays.map(Number)
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
      if (days.length) clean.weekdays = days;
    }

    const blackouts = [];
    for (const b of entry.blackouts || []) {
      if (!b || typeof b !== 'object') continue;
      let start = String(b.start || '').trim();
      let end = String(b.end || b.start || '').trim();
      if (!isDate(start) || !isDate(end)) continue;
      if (end < start) [start, end] = [end, start];
      blackouts.push({ start, end, reason: String(b.reason || '').trim() });
    }
    if (blackouts.length) clean.blackouts = blackouts;

    // Only keep the person if the model actually said something about them.
    if (Object.keys(clean).length > 1) people.push(clean);
  }

  const clashes = [];
  for (const pair of data.clashes || []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const a = canon.get(String(pair[0]).trim().toLowerCase());
    const b = canon.get(String(pair[1]).trim().toLowerCase());
    if (!a || !b || a === b) continue;
    if (clashes.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) continue;
    clashes.push([a, b]);
  }

  return { people, clashes };
}

/**
 * Convert free-text notes into structured, validated availability edits.
 * Returns { people, clashes }; throws AIError if the call or reply is unusable.
 */
export async function parseAvailability({ text, names, start, end, provider, model, apiKey }) {
  if (!text.trim()) return { people: [], clashes: [] };
  if (!apiKey) {
    throw new AIError(
      'No API key set. Add one in Settings, or just tick the days on the People screen.'
    );
  }
  const prompt = PROMPT
    .replace('{names}', names.join(', '))
    .replace('{start}', start)
    .replace('{end}', end)
    .replace('{text}', text.trim());

  return validate(extractJSON(await call(provider, model, apiKey, prompt)), names);
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Render a parse result as the plain-English list shown for approval. */
export function describe(result) {
  const lines = [];
  for (const p of result.people || []) {
    if (p.weekdays) {
      lines.push(`${p.name}: available ${p.weekdays.map((d) => DAY_NAMES[d]).join(', ')}`);
    }
    for (const b of p.blackouts || []) {
      const span = b.start === b.end ? b.start : `${b.start} to ${b.end}`;
      lines.push(`${p.name}: away ${span}${b.reason ? ` (${b.reason})` : ''}`);
    }
  }
  for (const [a, b] of result.clashes || []) {
    lines.push(`${a} + ${b}: never on the same shift`);
  }
  return lines;
}

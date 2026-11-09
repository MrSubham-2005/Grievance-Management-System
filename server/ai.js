// AI analysis for complaints. Provider, key and model come from the environment:
// AI_PROVIDER=gemini, AI_API_KEY=<key>, AI_MODEL=gemini-1.5-flash
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const CATEGORIES = [
  'Academic Section', 'Accounts', 'Administration', 'Admission Cell', 'Cafeteria',
  'Hostel', 'Library', 'Transport', 'Infrastructure', 'Examinations', 'Other',
];

function aiConfigured() {
  return Boolean(process.env.AI_API_KEY && process.env.AI_API_KEY.trim());
}

// Calls Gemini and returns the reply text. Throws an Error with a readable message.
async function askModel(prompt) {
  if (!aiConfigured()) {
    throw new Error('AI is not configured. Set AI_API_KEY in the server environment.');
  }
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
  if (provider !== 'gemini') {
    throw new Error(`Unsupported AI_PROVIDER "${provider}". Use gemini.`);
  }
  const model = process.env.AI_MODEL || 'gemini-1.5-flash';
  const res = await fetch(`${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.AI_API_KEY.trim(),
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body.error && body.error.message) || `HTTP ${res.status}`;
    throw new Error(`AI request failed: ${msg}`);
  }
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI returned an empty reply.');
  return text.trim();
}

function parseJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error('AI reply was not valid JSON.');
  }
}

// One analysis call that segments a complaint and returns a verdict for each decision.
async function analyzeComplaint(description, existing) {
  const existingList = existing.length
    ? existing.map((c) => `- ${c.complaint_id} (${c.category}): ${c.description}`).join('\n')
    : '(none)';

  const prompt = [
    'You are an assistant that triages student complaints for a college.',
    'Split the complaint into separate issues if it describes more than one problem.',
    `For each issue choose exactly one category from: ${CATEGORIES.join(', ')}.`,
    'Choose a priority for each issue: High (safety, health, or blocks study), Medium, or Low.',
    'Mark the complaint as SPAM only if it is meaningless, random keyboard text, abusive, a test, or contains no real issue.',
    'A short real complaint such as "WiFi is not working" is VALID.',
    'Check whether it duplicates one of the existing open complaints listed below.',
    'For every decision give a short plain reason (one sentence, no filler, no em dashes).',
    'Reply ONLY with JSON in this exact shape:',
    '{"spam":false,"spamReason":"","issues":[{"text":"","category":"","priority":"","reason":""}],',
    '"duplicateOf":"","duplicateReason":"","verdict":""}',
    'Use an empty duplicateOf if there is no duplicate. verdict is one plain sentence summarising the decision.',
    '',
    'Existing open complaints:',
    existingList,
    '',
    'Complaint:',
    description,
  ].join('\n');

  const result = parseJson(await askModel(prompt));
  const issues = Array.isArray(result.issues) ? result.issues : [];
  return {
    spam: Boolean(result.spam),
    spamReason: String(result.spamReason || ''),
    issues: issues.map((i) => ({
      text: String(i.text || ''),
      category: CATEGORIES.includes(i.category) ? i.category : 'Other',
      priority: ['High', 'Medium', 'Low'].includes(i.priority) ? i.priority : 'Medium',
      reason: String(i.reason || ''),
    })),
    duplicateOf: String(result.duplicateOf || ''),
    duplicateReason: String(result.duplicateReason || ''),
    verdict: String(result.verdict || ''),
  };
}

module.exports = { analyzeComplaint, aiConfigured, CATEGORIES };

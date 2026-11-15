// AI analysis for complaints. Provider, key and model come from the environment:
// AI_PROVIDER=gemini, AI_API_KEY=<key>, AI_MODEL=gemini-1.5-flash
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const CATEGORIES = [
  'Academic Section',
  'Accounts',
  'Administration',
  'Admission Cell',
  'Cafeteria',
  'Civil Lab',
  'Civil Maintenance',
  'Computer Lab',
  'Electrical Lab',
  'Electrical Maintenance',
  'Electronics Lab',
  'Examination Cell',
  'Hostel',
  'Housekeeping',
  'IT & Network Support',
  'Laboratory',
  'Library',
  'Maintenance',
  'Mechanical Lab',
  'Plumbing',
  'Scholarship Cell',
  'Security',
  'Sports Department',
  'Student Welfare',
  'Training & Placement',
  'Transport',
];

const CATEGORY_BY_LOWER = new Map(CATEGORIES.map((c) => [c.toLowerCase(), c]));

function normalizeCategory(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return CATEGORY_BY_LOWER.get(trimmed.toLowerCase()) || '';
}

const RESPONSE_JSON_SCHEMA = {
  type: 'OBJECT',
  properties: {
    spam: { type: 'BOOLEAN' },
    spamReason: { type: 'STRING' },
    issues: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          category: { type: 'STRING', enum: CATEGORIES },
          priority: { type: 'STRING', enum: ['High', 'Medium', 'Low'] },
          reason: { type: 'STRING' },
        },
        required: ['text', 'category', 'priority', 'reason'],
      },
    },
    duplicateOf: { type: 'STRING' },
    duplicateReason: { type: 'STRING' },
    verdict: { type: 'STRING' },
  },
  required: ['spam', 'spamReason', 'issues', 'duplicateOf', 'duplicateReason', 'verdict'],
};

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
  const model = process.env.AI_MODEL || 'gemini-3.5-flash-lite';
  const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent`;
  const payload = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseJsonSchema: RESPONSE_JSON_SCHEMA,
    },
  });

  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.AI_API_KEY.trim(),
      },
      body: payload,
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const retryable = res.status === 429 || res.status === 503;
      if (retryable && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 600 * attempt));
        continue;
      }
      const msg = (body.error && body.error.message) || `HTTP ${res.status}`;
      throw new Error(`AI request failed: ${msg}`);
    }
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('AI returned an empty reply.');
    return text.trim();
  }
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
  const text = typeof description === 'string' ? description.trim() : '';
  if (text.length < 5) {
    return {
      spam: false,
      spamReason: '',
      issues: [],
      duplicateOf: '',
      duplicateReason: '',
      verdict: '',
    };
  }

  const existingList = existing.length
    ? existing.map((c) => `- ${c.complaint_id} (${c.category}): ${c.description}`).join('\n')
    : '(none)';

  const prompt = [
    'You are an assistant that triages student complaints for a college.',
    'Analyze the actual issue described in the complaint rather than matching surface location words alone.',
    'Split the complaint into separate issues only if it describes more than one distinct problem, putting the primary issue first.',
    `For each issue choose the single most relevant category strictly from this exact list: ${CATEGORIES.join(', ')}.`,
    'Category scope guidance:',
    '- Wi-Fi, internet, network, router, LAN, campus portal, or IT login problems belong to "IT & Network Support" (even if located in a lab or hostel).',
    '- Lab PCs, monitors, keyboards, or computer lab software/systems belong to "Computer Lab". Engineering labs map to "Civil Lab", "Electrical Lab", "Electronics Lab", "Mechanical Lab", or general "Laboratory".',
    '- Building/classroom/hostel lights, fans, switches, wiring, AC, or power supply belong to "Electrical Maintenance" (not "Electrical Lab").',
    '- Water leaks, pipes, taps, toilets, sinks, or drains belong to "Plumbing" (even if inside a hostel or academic block).',
    '- Cleaning, sweeping, mopping, garbage, or hygiene belong to "Housekeeping" (even if inside a hostel or classroom).',
    '- Structural/masonry/carpentry/furniture/doors/windows repairs belong to "Civil Maintenance" or general "Maintenance".',
    '- Hostel room allotment, mess, warden, or general hostel facilities belong to "Hostel".',
    '- Tuition/college fees, billing, receipts, or fee payment issues belong to "Accounts"; scholarships/stipends belong to "Scholarship Cell".',
    '- Exam timetables, hall tickets, results, or grading belong to "Examination Cell"; admissions/enrollment belong to "Admission Cell".',
    'Choose a priority for each issue: High (safety, health, or blocks study), Medium, or Low.',
    'Mark the complaint as spam only if it is meaningless, random keyboard text, abusive, a test, or contains no real issue.',
    'A short real complaint such as "WiFi is not working" is valid (spam: false).',
    'Check whether it duplicates one of the existing open complaints listed below. Use an empty duplicateOf if there is no duplicate.',
    'For every decision give a short plain reason (one sentence, no filler, no em dashes).',
    'verdict must be one plain sentence summarising the decision.',
    '',
    'Existing open complaints:',
    existingList,
    '',
    'Complaint:',
    text,
  ].join('\n');

  const result = parseJson(await askModel(prompt));
  const rawIssues = Array.isArray(result.issues) ? result.issues : [];
  const issues = rawIssues
    .map((i) => ({
      text: String(i?.text || ''),
      category: normalizeCategory(i?.category),
      priority: ['High', 'Medium', 'Low'].includes(i?.priority) ? i.priority : 'Medium',
      reason: String(i?.reason || ''),
    }))
    .filter((i) => i.category !== '');

  return {
    spam: Boolean(result.spam),
    spamReason: String(result.spamReason || ''),
    issues,
    duplicateOf: String(result.duplicateOf || ''),
    duplicateReason: String(result.duplicateReason || ''),
    verdict: String(result.verdict || ''),
  };
}

module.exports = { analyzeComplaint, aiConfigured, CATEGORIES, normalizeCategory };

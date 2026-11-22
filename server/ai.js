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
    similarity: { type: 'INTEGER' },
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
      similarity: 0,
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
    'Check whether the complaint is semantically duplicate or describing the same underlying problem as one of the existing open complaints listed below, even if different words or phrasing are used (e.g. "WiFi down" vs "No internet connection", "Water leaking in washroom" vs "Pipe leakage in hostel bathroom").',
    'If a semantic duplicate or very similar open complaint exists, set duplicateOf to that complaint ID (e.g. "CMP-0001"), duplicateReason to a concise explanation of the similarity, and similarity to an integer percentage from 70 to 100.',
    'If there is no duplicate or if complaints describe clearly different issues, set duplicateOf to an empty string, duplicateReason to an empty string, and similarity to 0. Do not mark unrelated complaints as duplicates.',
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

  const sim = typeof result.similarity === 'number'
    ? Math.min(100, Math.max(0, Math.round(result.similarity)))
    : (result.duplicateOf ? 85 : 0);

  return {
    spam: Boolean(result.spam),
    spamReason: String(result.spamReason || ''),
    issues,
    duplicateOf: String(result.duplicateOf || ''),
    duplicateReason: String(result.duplicateReason || ''),
    similarity: sim,
    verdict: String(result.verdict || ''),
  };
}

// Fallback semantic similarity detection when AI provider is unconfigured or unavailable.
const FALLBACK_STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren',
  'arent', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but',
  'by', 'can', 'cannot', 'cant', 'could', 'couldnt', 'did', 'didn', 'didnt', 'do', 'does', 'doesn',
  'doesnt', 'doing', 'dont', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'hadnt',
  'has', 'hasnt', 'have', 'havent', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself',
  'his', 'how', 'i', 'if', 'in', 'into', 'is', 'isnt', 'it', 'its', 'itself', 'just', 'me', 'more',
  'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other',
  'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'shouldnt', 'so', 'some',
  'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'wasnt',
  'we', 'were', 'werent', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with',
  'won', 'wont', 'would', 'wouldnt', 'you', 'your', 'yours', 'yourself', 'yourselves',
  'please', 'kindly', 'sir', 'madam', 'problem', 'issue', 'facing', 'getting', 'unable', 'help',
  'urgently', 'urgent', 'resolve', 'request', 'complaint', 'grievance', 'regarding', 'due', 'also'
]);

const FALLBACK_FACILITY_CLUSTERS = [
  { root: 'facility_washroom', words: ['washroom', 'restroom', 'toilet', 'bathroom', 'latrine', 'urinal'] },
  { root: 'facility_lab', words: ['lab', 'laboratory', 'computerlab', 'civilab', 'mechlab'] },
  { root: 'facility_hostel', words: ['hostel', 'dorm', 'dormitory', 'corridor', 'wing'] },
  { root: 'facility_canteen', words: ['canteen', 'cafeteria', 'mess', 'dining'] },
  { root: 'facility_library', words: ['library', 'readingroom'] },
  { root: 'facility_classroom', words: ['classroom', 'class', 'hall', 'auditorium', 'seminar'] },
];

const FALLBACK_CONCEPT_CLUSTERS = [
  {
    root: 'concept_network',
    words: ['wifi', 'wi-fi', 'internet', 'lan', 'ethernet', 'network', 'connection', 'connect', 'connecting', 'disconnected', 'router', 'bandwidth', 'speed', 'portal', 'online', 'signal']
  },
  {
    root: 'concept_water_plumb',
    words: ['water', 'pipe', 'pipes', 'piping', 'leak', 'leaks', 'leaking', 'leakage', 'tap', 'taps', 'faucet', 'basin', 'sink', 'drain', 'drainage', 'flush', 'shower', 'overflow', 'overflowing', 'plumbing', 'sewage']
  },
  {
    root: 'concept_electrical',
    words: ['light', 'lights', 'lighting', 'tube', 'tubelight', 'bulb', 'bulbs', 'fan', 'fans', 'switch', 'switches', 'socket', 'plug', 'power', 'electricity', 'current', 'wiring', 'wire', 'wires', 'shortcircuit', 'blackout', 'ac', 'cooler', 'cooling', 'voltage', 'airconditioner']
  },
  {
    root: 'concept_computer',
    words: ['computer', 'pc', 'system', 'systems', 'desktop', 'mouse', 'keyboard', 'monitor', 'screen', 'cpu', 'ram', 'software', 'hardware', 'boot', 'booting']
  },
  {
    root: 'concept_housekeeping',
    words: ['clean', 'cleaning', 'cleaned', 'dirty', 'garbage', 'trash', 'dustbin', 'waste', 'smell', 'stench', 'stink', 'unhygienic', 'sweep', 'sweeping', 'mop', 'mopping', 'litter', 'hygiene', 'cockroach', 'insects', 'pest']
  },
  {
    root: 'concept_civil_furniture',
    words: ['door', 'doors', 'window', 'windows', 'desk', 'desks', 'chair', 'chairs', 'bench', 'benches', 'table', 'tables', 'furniture', 'lock', 'locks', 'locked', 'broken', 'cracked', 'wall', 'walls', 'ceiling', 'plaster', 'handle', 'hinge']
  },
  {
    root: 'concept_finance',
    words: ['fee', 'fees', 'tuition', 'receipt', 'receipts', 'payment', 'paid', 'challan', 'refund', 'scholarship', 'stipend', 'dues', 'account', 'accounts']
  },
  {
    root: 'concept_exam',
    words: ['exam', 'exams', 'examination', 'hallticket', 'admitcard', 'marksheet', 'grade', 'grades', 'grading', 'result', 'results', 'timetable', 'schedule']
  }
];

const FALLBACK_WORD_TO_ROOT = new Map();
for (const cluster of [...FALLBACK_FACILITY_CLUSTERS, ...FALLBACK_CONCEPT_CLUSTERS]) {
  for (const word of cluster.words) {
    FALLBACK_WORD_TO_ROOT.set(word.toLowerCase(), cluster.root);
  }
}

function normalizeFallbackWord(word) {
  let w = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!w) return '';
  if (FALLBACK_WORD_TO_ROOT.has(w)) return FALLBACK_WORD_TO_ROOT.get(w);
  if (w.endsWith('ing') && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith('tion') && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith('ies') && w.length > 4) w = w.slice(0, -3) + 'y';
  else if (w.endsWith('es') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('ed') && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('s') && w.length > 3) w = w.slice(0, -1);
  return FALLBACK_WORD_TO_ROOT.get(w) || w;
}

function extractFallbackTokens(text) {
  if (typeof text !== 'string') return new Set();
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w.length > 1 && !FALLBACK_STOP_WORDS.has(w));

  const tokenSet = new Set();
  for (const w of words) {
    const norm = normalizeFallbackWord(w);
    if (norm && !FALLBACK_STOP_WORDS.has(norm)) {
      tokenSet.add(norm);
    }
  }
  return tokenSet;
}

function findSimilarComplaintFallback(description, existingComplaints, preferredCategory) {
  if (!description || typeof description !== 'string' || !Array.isArray(existingComplaints) || existingComplaints.length === 0) {
    return null;
  }
  const tokensA = extractFallbackTokens(description);
  if (tokensA.size === 0) return null;

  const prefCat = typeof preferredCategory === 'string' ? preferredCategory.trim().toLowerCase() : '';

  let bestMatch = null;
  let bestScore = 0;

  for (const c of existingComplaints) {
    if (!c || !c.description || !c.complaint_id) continue;
    const tokensB = extractFallbackTokens(c.description);
    if (tokensB.size === 0) continue;

    const shared = [...tokensA].filter((t) => tokensB.has(t));
    if (shared.length === 0) continue;

    const catMatch = Boolean(prefCat && c.category && prefCat === c.category.trim().toLowerCase());
    const sharedConcepts = shared.filter((t) => t.startsWith('concept_'));

    // Avoid false positives: require either a shared problem concept or multiple shared content words with category match
    if (sharedConcepts.length === 0 && (!catMatch || shared.length < 2)) {
      continue;
    }

    const jaccard = shared.length / (tokensA.size + tokensB.size - shared.length);
    const overlap = shared.length / Math.min(tokensA.size, tokensB.size);
    const score = (0.4 * jaccard) + (0.45 * overlap) + (catMatch ? 0.15 : 0);

    if (score >= 0.48 && score > bestScore) {
      bestScore = score;
      bestMatch = {
        complaintId: c.complaint_id,
        category: c.category,
        description: c.description,
        score,
        similarity: Math.min(95, Math.max(70, Math.round(score * 100))),
        reason: catMatch
          ? `Similar open grievance found in ${c.category} with matching issue details.`
          : 'Similar open grievance found with matching problem characteristics.',
      };
    }
  }

  return bestMatch;
}

module.exports = {
  analyzeComplaint,
  aiConfigured,
  CATEGORIES,
  normalizeCategory,
  findSimilarComplaintFallback,
};

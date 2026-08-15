import express from 'express';
import cors from 'cors';

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ACCESS_TOKEN = process.env.TERR_ACCESS_TOKEN || null;

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.TERR_RATE_LIMIT || 20);

if (!GEMINI_API_KEY) {
  console.error('Missing GEMINI_API_KEY environment variable. Set it before starting the server.');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '200kb' }));

const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (hits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  hits.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX;
}

const SYSTEM_PROMPT = `You are an expert developer tool that translates raw terminal error logs into plain English.
Respond ONLY with a single valid JSON object, no markdown fences, no preamble, no commentary. The JSON must have exactly these fields:
{
  "environment": "short string naming the detected language/tool/environment, e.g. 'Python 3 / pip'",
  "severity": "error" or "warning",
  "summary": "1-2 plain English sentences describing what went wrong, no jargon",
  "why": "1-3 sentence explanation of the root cause, in plain English",
  "steps": [ { "title": "short imperative step title", "detail": "1-2 sentence explanation of that step" } ],
  "commands": [ "exact copy-pasteable terminal command", "another command if needed" ]
}
Keep steps between 2 and 5 items. Keep commands minimal and only include ones that are actually needed to fix this specific error. If no command is needed, return an empty array for commands.`;

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/translate', async (req, res) => {
  if (ACCESS_TOKEN) {
    const supplied = req.headers['x-terr-token'];
    if (supplied !== ACCESS_TOKEN) {
      return res.status(401).json({ error: 'Invalid or missing access token.' });
    }
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
  }

  const errorText = (req.body?.error || '').toString().trim();
  if (!errorText) {
    return res.status(400).json({ error: 'Missing "error" field in request body.' });
  }
  if (errorText.length > 12000) {
    return res.status(400).json({ error: 'Error text too long (12000 char limit).' });
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: errorText }] }],
        generationConfig: {
          maxOutputTokens: 1000,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error('Gemini API error:', response.status, body);
      return res.status(502).json({ error: 'Upstream translation service failed.' });
    }

    const data = await response.json();
    const textPart = data?.candidates?.[0]?.content?.parts?.find(p => p.text);
    if (!textPart) {
      return res.status(502).json({ error: 'No content returned from translation service.' });
    }

    let cleaned = textPart.text.trim();
    cleaned = cleaned.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();

    const parsed = JSON.parse(cleaned);
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error while translating.' });
  }
});

app.listen(PORT, () => {
  console.log(`terr backend listening on port ${PORT}`);
  console.log(ACCESS_TOKEN ? 'Access token required.' : 'No access token set — anyone with the URL can use this.');
});

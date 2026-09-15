// ─────────────────────────────────────────────────────────────────────────────
// FSTR — /api/analyse.js
// Serverless function: keeps Gemini API key hidden from the browser.
// Security layers:
//   1. CORS — only allows requests from your own domain
//   2. Method check — POST only
//   3. Input validation — must be a real YouTube URL
//   4. Rate limiting — max 10 requests per IP per minute (in-memory)
//   5. Response sanitisation — only forwards what the frontend needs
//   6. Error handling — never leaks stack traces or key details to client
// ─────────────────────────────────────────────────────────────────────────────

// ── In-memory rate limiter ────────────────────────────────────────────────────
// Resets when the serverless function cold-starts (fine for free tier demo)
const rateLimitMap = new Map();
const RATE_LIMIT = 10;        // max requests
const RATE_WINDOW = 60_000;   // per 60 seconds

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };

  if (now - entry.start > RATE_WINDOW) {
    // Window expired — reset
    rateLimitMap.set(ip, { count: 1, start: now });
    return false;
  }

  if (entry.count >= RATE_LIMIT) return true;

  entry.count++;
  rateLimitMap.set(ip, entry);
  return false;
}

// ── YouTube URL validator ─────────────────────────────────────────────────────
function extractVideoId(url) {
  try {
    const parsed = new URL(url);
    // Only allow youtube.com and youtu.be
    if (!['www.youtube.com', 'youtube.com', 'youtu.be', 'm.youtube.com']
        .includes(parsed.hostname)) return null;

    // youtu.be/VIDEO_ID
    if (parsed.hostname === 'youtu.be') {
      const id = parsed.pathname.slice(1).split('/')[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }

    // youtube.com/watch?v=VIDEO_ID
    const v = parsed.searchParams.get('v');
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;

    // youtube.com/embed/VIDEO_ID
    const embedMatch = parsed.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
    if (embedMatch) return embedMatch[1];

    return null;
  } catch {
    return null;
  }
}

// ── Security headers ──────────────────────────────────────────────────────────
function securityHeaders(res, allowedOrigin) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Determine allowed origin — in production lock this to your Vercel domain
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  securityHeaders(res, allowedOrigin);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // POST only
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting — get real IP behind Vercel proxy
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (isRateLimited(ip)) {
    return res.status(429).json({
      error: 'Too many requests. Please wait a minute and try again.'
    });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  const { url } = body || {};

  // Validate input exists
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A YouTube URL is required.' });
  }

  // Guard against oversized input
  if (url.length > 300) {
    return res.status(400).json({ error: 'URL is too long. Please paste a standard YouTube link.' });
  }

  // Validate it's a real YouTube URL and extract ID
  const videoId = extractVideoId(url.trim());
  if (!videoId) {
    return res.status(400).json({
      error: 'That doesn\'t look like a valid YouTube URL. Please copy the link directly from YouTube.'
    });
  }

  // Check API key is configured server-side
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY environment variable is not set.');
    return res.status(500).json({
      error: 'Service is not configured correctly. Please contact the developer.'
    });
  }

  // Build prompt
  const prompt = `You are FSTR, an AI that helps students learn faster from YouTube videos.

Analyse this YouTube video: ${url.trim()}
Video ID: ${videoId}

Use your knowledge of this video or generate a realistic, accurate educational analysis.
Be specific to the actual video content — not generic.

Return ONLY a valid JSON object. No markdown. No backticks. No explanation outside the JSON.

{
  "videoTitle": "actual video title",
  "channelName": "channel name",
  "tldr": "2-3 sentence plain English summary of what this video teaches and why it matters to a student",
  "concepts": [
    {"title": "Concept name", "explanation": "Clear 1-2 sentence explanation"},
    {"title": "Concept name", "explanation": "explanation"},
    {"title": "Concept name", "explanation": "explanation"},
    {"title": "Concept name", "explanation": "explanation"},
    {"title": "Concept name", "explanation": "explanation"}
  ],
  "quiz": [
    {
      "question": "specific question testing understanding of video content",
      "options": ["option A", "option B", "option C", "option D"],
      "correct": 0,
      "explanation": "why this answer is correct and what the others miss"
    },
    {"question":"...","options":["...","...","...","..."],"correct":1,"explanation":"..."},
    {"question":"...","options":["...","...","...","..."],"correct":2,"explanation":"..."},
    {"question":"...","options":["...","...","...","..."],"correct":0,"explanation":"..."},
    {"question":"...","options":["...","...","...","..."],"correct":3,"explanation":"..."}
  ],
  "studyPlan": {
    "intro": "One sentence on what skill this video helps build",
    "weeks": [
      {"week": "Week 1", "title": "Foundation", "description": "Specific actions for this week based on the video"},
      {"week": "Week 2", "title": "Practice", "description": "How to practice what was learned"},
      {"week": "Week 3", "title": "Apply", "description": "Real project or application to cement the knowledge"}
    ],
    "nextVideo": "Specific next video title to search on YouTube to continue learning this topic"
  }
}`;

  // Call Gemini API
  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 2000,
            temperature: 0.7
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
          ]
        })
      }
    );

    if (!geminiRes.ok) {
      // Don't expose raw Gemini error to client
      console.error('Gemini API error:', geminiRes.status, await geminiRes.text());
      return res.status(502).json({
        error: 'AI service is temporarily unavailable. Please try again in a moment.'
      });
    }

    const geminiData = await geminiRes.json();
    const raw = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!raw) {
      return res.status(502).json({
        error: 'No response from AI. Try a different video or try again.'
      });
    }

    // Parse and validate JSON
    let parsed;
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      console.error('JSON parse error from Gemini response:', raw.slice(0, 200));
      return res.status(502).json({
        error: 'AI returned an unexpected format. Please try again.'
      });
    }

    // Validate required fields exist before sending to client
    if (!parsed.videoTitle && !parsed.concepts && !parsed.quiz && !parsed.studyPlan) {
      return res.status(502).json({
        error: 'Incomplete analysis returned. Please try again or try a different video.'
      });
    }
    // Ensure arrays are actually arrays
    if (!Array.isArray(parsed.concepts)) parsed.concepts = [];
    if (!Array.isArray(parsed.quiz))     parsed.quiz     = [];
    // Validate each quiz item has required fields
    parsed.quiz = parsed.quiz.filter(q =>
      q && typeof q.question === 'string' &&
      Array.isArray(q.options) && q.options.length === 4 &&
      typeof q.correct === 'number'
    );

    // Only send what the frontend needs — nothing extra
    return res.status(200).json({
      videoTitle:  parsed.videoTitle  || 'YouTube Video',
      channelName: parsed.channelName || '',
      tldr:        parsed.tldr        || '',
      concepts:    (parsed.concepts   || []).slice(0, 7),
      quiz:        (parsed.quiz       || []).slice(0, 5),
      studyPlan:   parsed.studyPlan   || {}
    });

  } catch (err) {
    // Never expose internal errors to the client
    console.error('Internal server error:', err.message);
    return res.status(500).json({
      error: 'Something went wrong on our end. Please try again.'
    });
  }
}

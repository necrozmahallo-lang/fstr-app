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
  const prompt = `You are FSTR, an AI learning tool. Analyse this YouTube video and return educational content.

Video URL: ${url.trim()}
Video ID: ${videoId}

Important: Use your knowledge of this video to provide SPECIFIC and DETAILED content — not generic placeholders. If you don't know the exact video, make the analysis realistic and educational based on the topic the URL suggests.

You MUST return ONLY a valid raw JSON object. No markdown. No backticks. No text before or after the JSON. Start your response with { and end with }.

Use this EXACT structure:

{"videoTitle":"The actual title of this video","channelName":"The YouTube channel name","tldr":"A detailed 3-4 sentence summary explaining exactly what this video teaches, why it matters, and what the viewer will understand by the end. Be specific to this video's content.","concepts":[{"title":"First key concept title","explanation":"Detailed 2-3 sentence explanation of this concept as taught in the video. Include the why and how, not just the what."},{"title":"Second concept","explanation":"Detailed explanation"},{"title":"Third concept","explanation":"Detailed explanation"},{"title":"Fourth concept","explanation":"Detailed explanation"},{"title":"Fifth concept","explanation":"Detailed explanation"},{"title":"Sixth concept","explanation":"Detailed explanation"},{"title":"Seventh concept","explanation":"Detailed explanation"}],"quiz":[{"question":"A specific question testing real understanding of this video content — not just recall","options":["Plausible wrong answer","Correct answer","Another plausible wrong answer","Another wrong answer"],"correct":1,"explanation":"Detailed explanation of why this is correct and what the wrong answers miss"},{"question":"Second question","options":["A","B","C","D"],"correct":0,"explanation":"Explanation"},{"question":"Third question","options":["A","B","C","D"],"correct":2,"explanation":"Explanation"},{"question":"Fourth question","options":["A","B","C","D"],"correct":3,"explanation":"Explanation"},{"question":"Fifth question","options":["A","B","C","D"],"correct":1,"explanation":"Explanation"}],"studyPlan":{"intro":"One sentence describing what skill or knowledge this video is helping build.","weeks":[{"week":"Week 1","title":"Build the Foundation","goal":"What the student should understand or be able to do by end of week 1","days":[{"label":"Day 1-2","task":"Specific actionable task for these days related to this video content"},{"label":"Day 3-4","task":"Specific actionable task"},{"label":"Day 5-7","task":"Specific actionable task to consolidate week 1 learning"}]},{"week":"Week 2","title":"Practice and Apply","goal":"What the student should be able to do independently by end of week 2","days":[{"label":"Day 1-2","task":"Specific practice task"},{"label":"Day 3-5","task":"Specific project or exercise"},{"label":"Day 6-7","task":"Review and reinforce"}]},{"week":"Week 3","title":"Build Something Real","goal":"A completed project or demonstrated skill that proves mastery","days":[{"label":"Project","task":"Specific project description that uses everything learned"},{"label":"Requirements","task":"What the finished project must include or demonstrate"},{"label":"Share","task":"How to publish, share or present the finished work"}]}],"nextVideo":"Specific YouTube search query to find the best next video to watch on this topic"}}`;

  // Call Gemini API
  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 4000,
            temperature: 0.5
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

// ─────────────────────────────────────────────────────────────────────────────
// FSTR — /api/analyse.js
// Fetches the actual YouTube transcript then sends it to Gemini for deep analysis.
// ─────────────────────────────────────────────────────────────────────────────

const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60_000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) { rateLimitMap.set(ip, { count: 1, start: now }); return false; }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++; rateLimitMap.set(ip, entry); return false;
}

function extractVideoId(url) {
  try {
    const parsed = new URL(url);
    if (!['www.youtube.com','youtube.com','youtu.be','m.youtube.com'].includes(parsed.hostname)) return null;
    if (parsed.hostname === 'youtu.be') {
      const id = parsed.pathname.slice(1).split('/')[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    const v = parsed.searchParams.get('v');
    if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    const em = parsed.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
    if (em) return em[1];
    return null;
  } catch { return null; }
}

function securityHeaders(res, origin) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function fetchTranscript(videoId) {
  try {
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const html = await pageRes.text();

    // Title extraction — multiple fallbacks
    let title = '';
    const titlePatterns = [
      /\"title\":\{\"runs\":\[\{\"text\":\"([^\"]+)\"/,
      /\"title\":\"([^\"]+)\"/,
      /<title>([^<]+) - YouTube<\/title>/,
      /og:title" content="([^"]+)"/
    ];
    for (const p of titlePatterns) {
      const m = html.match(p);
      if (m?.[1] && m[1].length > 3 && !m[1].includes('{{')) {
        title = m[1].replace(/\\u0026/g,'&').replace(/\\"/g,'"').replace(/\\\\/g,'\\');
        break;
      }
    }

    // Channel extraction — multiple fallbacks
    let channel = '';
    const channelPatterns = [/\"ownerChannelName\":\"([^\"]+)\"/, /\"author\":\"([^\"]+)\"/, /\"channelName\":\"([^\"]+)\"/];
    for (const p of channelPatterns) {
      const m = html.match(p);
      if (m?.[1]) { channel = m[1]; break; }
    }

    // Caption tracks
    const capMatch = html.match(/\"captionTracks\":(\[.*?\])/);
    if (!capMatch) return { title, channel, transcript: null };

    const tracks = JSON.parse(capMatch[1].replace(/\\u0026/g,'&').replace(/\\"/g,'"'));
    const track = tracks.find(t => t.languageCode === 'en') || tracks.find(t => t.languageCode?.startsWith('en')) || tracks[0];
    if (!track?.baseUrl) return { title, channel, transcript: null };

    const capRes = await fetch(track.baseUrl);
    const xml = await capRes.text();
    const transcript = (xml.match(/<text[^>]*>([^<]*)<\/text>/g) || [])
      .map(t => t.replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim())
      .filter(Boolean).join(' ').substring(0, 8000);

    return { title, channel, transcript };
  } catch (err) {
    console.error('Transcript error:', err.message);
    return { title: '', channel: '', transcript: null };
  }
}

export default async function handler(req, res) {
  securityHeaders(res, process.env.ALLOWED_ORIGIN || '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Invalid request.' }); }

  const { url } = body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'A YouTube URL is required.' });
  if (url.length > 300) return res.status(400).json({ error: 'URL is too long.' });

  const videoId = extractVideoId(url.trim());
  if (!videoId) return res.status(400).json({ error: 'Please paste a valid YouTube URL.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Service not configured correctly.' });

  const { title, channel, transcript } = await fetchTranscript(videoId);

  const contentSection = transcript
    ? `ACTUAL VIDEO TRANSCRIPT (read this carefully — your entire analysis must be based on this):\n\n"${transcript}"\n\nVideo Title: ${title}\nChannel: ${channel}`
    : `Video URL: ${url.trim()}\nVideo ID: ${videoId}\nVideo Title (from page): ${title}\nChannel: ${channel}\nNote: No transcript available. Use your best knowledge of this specific video.`;

  const prompt = `You are FSTR, an AI learning tool. Analyse this YouTube video and return study material.

${contentSection}

RULES:
1. Return ONLY raw JSON — no markdown, no backticks, nothing outside { }
2. Be SPECIFIC to this video's actual content — not generic summaries
3. Reference what the presenter actually said, examples they used, frameworks they introduced

{"videoTitle":"${title || 'YouTube Video'}","channelName":"${channel || ''}","tldr":"3-4 sentences. What specific problem does this video address? What is the presenter's specific approach? What will the viewer understand after watching?","concepts":[{"title":"First key concept from this video","explanation":"2-3 sentences. Explain exactly how this presenter explained this concept. Reference specific examples or analogies they used."},{"title":"Second concept","explanation":"2-3 specific sentences from the video"},{"title":"Third concept","explanation":"2-3 specific sentences from the video"},{"title":"Fourth concept","explanation":"2-3 specific sentences from the video"},{"title":"Fifth concept","explanation":"2-3 specific sentences from the video"}],"quiz":[{"question":"Specific question about a point from this video","options":["Wrong but plausible","Correct answer based on video","Another wrong answer","Another wrong answer"],"correct":1,"explanation":"Why this is correct based on what the video said."},{"question":"Second question","options":["A","B","C","D"],"correct":0,"explanation":"Explanation"},{"question":"Third question","options":["A","B","C","D"],"correct":2,"explanation":"Explanation"},{"question":"Fourth question","options":["A","B","C","D"],"correct":3,"explanation":"Explanation"},{"question":"Fifth question","options":["A","B","C","D"],"correct":1,"explanation":"Explanation"}],"studyPlan":{"intro":"One sentence on the specific skill this video builds.","weeks":[{"week":"Week 1","title":"Build the Foundation","goal":"Specific goal for week 1","days":[{"label":"Day 1-2","task":"Specific task referencing this video's content"},{"label":"Day 3-4","task":"Specific practice task"},{"label":"Day 5-7","task":"Consolidation exercise"}]},{"week":"Week 2","title":"Practice and Apply","goal":"Specific independent capability","days":[{"label":"Day 1-2","task":"Specific practice"},{"label":"Day 3-5","task":"Specific mini-project"},{"label":"Day 6-7","task":"Review and identify gaps"}]},{"week":"Week 3","title":"Build Something Real","goal":"Completed deliverable proving mastery","days":[{"label":"Project","task":"Specific project using this video's content"},{"label":"Requirements","task":"What the project must demonstrate"},{"label":"Share","task":"How to publish or showcase it"}]}],"nextVideo":"Best YouTube search query for the next video on this topic"}}`;

  try {
    const gemRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 3000, temperature: 0.35 },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
          ]
        })
      }
    );

    if (!gemRes.ok) {
      console.error('Gemini error:', gemRes.status, await gemRes.text());
      return res.status(502).json({ error: 'AI service temporarily unavailable. Please try again.' });
    }

    const gemData = await gemRes.json();
    const raw = gemData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!raw) return res.status(502).json({ error: 'No response from AI. Try again.' });

    let parsed;
    try {
      // Strip any accidental markdown fences
      const clean = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
      parsed = JSON.parse(clean);
    } catch {
      // Try to extract JSON from response if wrapped in text
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); }
        catch { return res.status(502).json({ error: 'AI returned unexpected format. Please try again.' }); }
      } else {
        return res.status(502).json({ error: 'AI returned unexpected format. Please try again.' });
      }
    }

    if (!Array.isArray(parsed.concepts)) parsed.concepts = [];
    if (!Array.isArray(parsed.quiz)) parsed.quiz = [];
    parsed.quiz = parsed.quiz.filter(q =>
      q && typeof q.question === 'string' &&
      Array.isArray(q.options) && q.options.length === 4 &&
      typeof q.correct === 'number'
    );

    return res.status(200).json({
      videoTitle:  parsed.videoTitle  || title || 'YouTube Video',
      channelName: parsed.channelName || channel || '',
      tldr:        parsed.tldr        || '',
      concepts:    (parsed.concepts   || []).slice(0, 7),
      quiz:        (parsed.quiz       || []).slice(0, 5),
      studyPlan:   parsed.studyPlan   || {}
    });

  } catch (err) {
    console.error('Internal error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

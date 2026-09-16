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
      .filter(Boolean).join(' ').substring(0, 14000);

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

  const prompt = `You are FSTR, a world-class educational AI that transforms YouTube videos into deeply insightful learning materials.

${contentSection}

Your job: Produce a DEEPLY SPECIFIC, HIGHLY DETAILED analysis of this exact video. Every sentence must reference actual content from the transcript above. Never write generic statements that could apply to any video on this topic. If the presenter makes a specific point, name it. If they give an example, reference it. If they use a specific analogy or framework, include it.

CRITICAL RULES:
1. Return ONLY a raw JSON object — no markdown, no backticks, nothing before { or after }
2. Every field must be deeply specific to THIS video's actual content
3. Concepts must explain the SPECIFIC way this presenter explained each idea — not textbook definitions
4. The TL;DR must mention specific arguments or frameworks from THIS video
5. Study plan tasks must reference THIS video's content specifically

Return this exact JSON structure:

{"videoTitle":"${title || 'YouTube Video'}","channelName":"${channel || ''}","tldr":"4-5 sentences. Start with what specific problem or question this video addresses. Explain the presenter's specific approach or framework. Mention 2-3 specific arguments or insights they make. End with what the viewer will be able to do or understand after watching.","concepts":[{"title":"Specific concept title from this video","explanation":"3-4 sentences. Explain this concept EXACTLY as presented in the video. Reference the specific way the presenter explained it, any examples they used, any frameworks or analogies they introduced. Be so specific that someone who watched the video would immediately recognise this explanation."},{"title":"Second concept","explanation":"3-4 sentences specific to this video"},{"title":"Third concept","explanation":"3-4 sentences specific to this video"},{"title":"Fourth concept","explanation":"3-4 sentences specific to this video"},{"title":"Fifth concept","explanation":"3-4 sentences specific to this video"},{"title":"Sixth concept","explanation":"3-4 sentences specific to this video"},{"title":"Seventh concept","explanation":"3-4 sentences specific to this video"}],"quiz":[{"question":"A specific question about a point made in this video — not generic","options":["Plausible but wrong answer","Correct answer matching what the video said","Another plausible wrong answer","Another wrong answer"],"correct":1,"explanation":"2-3 sentences explaining why this is correct based on what the video actually said, and what the wrong answers miss."},{"question":"Second specific question","options":["A","B","C","D"],"correct":0,"explanation":"Detailed explanation"},{"question":"Third question","options":["A","B","C","D"],"correct":2,"explanation":"Detailed explanation"},{"question":"Fourth question","options":["A","B","C","D"],"correct":3,"explanation":"Detailed explanation"},{"question":"Fifth question","options":["A","B","C","D"],"correct":1,"explanation":"Detailed explanation"}],"studyPlan":{"intro":"One sentence on the specific skill or knowledge this video builds — mention the topic explicitly.","weeks":[{"week":"Week 1","title":"Build the Foundation","goal":"Specific goal based on this video's content","days":[{"label":"Day 1–2","task":"Specific actionable task directly referencing this video's concepts"},{"label":"Day 3–4","task":"Specific practice task building on the video"},{"label":"Day 5–7","task":"Specific consolidation exercise"}]},{"week":"Week 2","title":"Practice and Apply","goal":"Specific independent capability goal","days":[{"label":"Day 1–2","task":"Specific practice directly related to this video's topic"},{"label":"Day 3–5","task":"Specific mini-project or exercise"},{"label":"Day 6–7","task":"Review and identify gaps"}]},{"week":"Week 3","title":"Build Something Real","goal":"A completed deliverable that proves mastery of this topic","days":[{"label":"Project","task":"Specific project idea that uses everything taught in this video"},{"label":"Requirements","task":"Specific things the project must demonstrate from this video's teachings"},{"label":"Share","task":"How to publish or showcase this specific work"}]}],"nextVideo":"Specific YouTube search query for the best next video on this exact topic"}}`;

  try {
    const gemRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 4500, temperature: 0.3 },
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

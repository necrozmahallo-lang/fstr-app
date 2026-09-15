// ─────────────────────────────────────────────────────────────────────────────
// FSTR — /api/analyse.js
// Fetches the actual YouTube transcript then sends it to Gemini for analysis.
// ─────────────────────────────────────────────────────────────────────────────

const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60_000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) {
    rateLimitMap.set(ip, { count: 1, start: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
  entry.count++;
  rateLimitMap.set(ip, entry);
  return false;
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
    const embedMatch = parsed.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
    if (embedMatch) return embedMatch[1];
    return null;
  } catch { return null; }
}

function securityHeaders(res, allowedOrigin) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Fetch transcript from YouTube using the timedtext API
async function fetchTranscript(videoId) {
  try {
    // First get the video page to find caption track URL
    const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const html = await pageRes.text();

    // Extract video title
    const titleMatch = html.match(/"title":"([^"]+)"/);
    const title = titleMatch ? titleMatch[1].replace(/\\u0026/g,'&').replace(/\\"/g,'"') : '';

    // Extract channel name
    const channelMatch = html.match(/"ownerChannelName":"([^"]+)"/);
    const channel = channelMatch ? channelMatch[1] : '';

    // Find caption tracks in the page source
    const captionMatch = html.match(/"captionTracks":(\[.*?\])/);
    if (!captionMatch) {
      return { title, channel, transcript: null };
    }

    const captionTracks = JSON.parse(captionMatch[1].replace(/\\u0026/g,'&').replace(/\\"/g,'"'));

    // Prefer English captions
    const track = captionTracks.find(t => t.languageCode === 'en') ||
                  captionTracks.find(t => t.languageCode?.startsWith('en')) ||
                  captionTracks[0];

    if (!track?.baseUrl) return { title, channel, transcript: null };

    // Fetch the caption XML
    const captionRes = await fetch(track.baseUrl);
    const captionXml = await captionRes.text();

    // Parse XML to extract text
    const textMatches = captionXml.match(/<text[^>]*>([^<]*)<\/text>/g) || [];
    const transcript = textMatches
      .map(t => t.replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim())
      .filter(Boolean)
      .join(' ')
      .substring(0, 12000); // Limit to 12k chars to stay within token limits

    return { title, channel, transcript };
  } catch (err) {
    console.error('Transcript fetch error:', err.message);
    return { title: '', channel: '', transcript: null };
  }
}

export default async function handler(req, res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  securityHeaders(res, allowedOrigin);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch { return res.status(400).json({ error: 'Invalid request body.' }); }

  const { url } = body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'A YouTube URL is required.' });
  if (url.length > 300) return res.status(400).json({ error: 'URL is too long.' });

  const videoId = extractVideoId(url.trim());
  if (!videoId) return res.status(400).json({ error: 'That doesn\'t look like a valid YouTube URL.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY not set');
    return res.status(500).json({ error: 'Service not configured correctly.' });
  }

  // Fetch actual transcript
  const { title, channel, transcript } = await fetchTranscript(videoId);

  // Build prompt — use transcript if available, otherwise use URL context
  const contentSection = transcript
    ? `Here is the actual transcript of the video (first 12,000 characters):\n\n"${transcript}"\n\nVideo title: ${title}\nChannel: ${channel}`
    : `Video URL: ${url.trim()}\nVideo ID: ${videoId}\nNote: No transcript available. Use your knowledge of this video or make a realistic analysis based on the URL and video ID.`;

  const prompt = `You are FSTR, an AI learning tool that helps students learn faster from YouTube videos.

${contentSection}

Analyse this video and return detailed, specific educational content based on the ACTUAL video content above.

CRITICAL: Return ONLY a raw JSON object. No markdown. No backticks. No text before or after. Start with { and end with }.

{"videoTitle":"${title || 'YouTube Video'}","channelName":"${channel || ''}","tldr":"A detailed 3-4 sentence summary of exactly what this video teaches based on its actual content. Be specific to what was said in the transcript.","concepts":[{"title":"First key concept from the video","explanation":"Detailed 2-3 sentence explanation of this concept exactly as it was explained in the video. Reference specific points made."},{"title":"Second concept","explanation":"Detailed specific explanation"},{"title":"Third concept","explanation":"Detailed specific explanation"},{"title":"Fourth concept","explanation":"Detailed specific explanation"},{"title":"Fifth concept","explanation":"Detailed specific explanation"},{"title":"Sixth concept","explanation":"Detailed specific explanation"},{"title":"Seventh concept","explanation":"Detailed specific explanation"}],"quiz":[{"question":"Question testing understanding of a specific point from this video","options":["Wrong but plausible answer","Correct answer based on video","Another wrong answer","Another wrong answer"],"correct":1,"explanation":"Why this is correct based on what the video actually said"},{"question":"Second question from video content","options":["A","B","C","D"],"correct":0,"explanation":"Explanation"},{"question":"Third question","options":["A","B","C","D"],"correct":2,"explanation":"Explanation"},{"question":"Fourth question","options":["A","B","C","D"],"correct":3,"explanation":"Explanation"},{"question":"Fifth question","options":["A","B","C","D"],"correct":1,"explanation":"Explanation"}],"studyPlan":{"intro":"One sentence on the skill or knowledge this video builds.","weeks":[{"week":"Week 1","title":"Build the Foundation","goal":"What to understand by end of week 1","days":[{"label":"Day 1-2","task":"Specific task based on this video's content"},{"label":"Day 3-4","task":"Specific practice task"},{"label":"Day 5-7","task":"Consolidation task"}]},{"week":"Week 2","title":"Practice and Apply","goal":"What to be able to do independently","days":[{"label":"Day 1-2","task":"Specific practice"},{"label":"Day 3-5","task":"Specific project"},{"label":"Day 6-7","task":"Review and reinforce"}]},{"week":"Week 3","title":"Build Something Real","goal":"Completed project proving mastery","days":[{"label":"Project","task":"Specific project using everything learned from this video"},{"label":"Requirements","task":"What the project must demonstrate"},{"label":"Share","task":"How to publish or present the work"}]}],"nextVideo":"Best next YouTube search query to continue learning this topic"}}`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 4000, temperature: 0.4 },
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
      console.error('Gemini API error:', geminiRes.status, await geminiRes.text());
      return res.status(502).json({ error: 'AI service is temporarily unavailable. Please try again in a moment.' });
    }

    const geminiData = await geminiRes.json();
    const raw = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!raw) return res.status(502).json({ error: 'No response from AI. Try a different video or try again.' });

    let parsed;
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      console.error('JSON parse error:', raw.slice(0, 300));
      return res.status(502).json({ error: 'AI returned an unexpected format. Please try again.' });
    }

    if (!parsed.videoTitle && !parsed.concepts && !parsed.quiz && !parsed.studyPlan) {
      return res.status(502).json({ error: 'Incomplete analysis. Please try again.' });
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
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again.' });
  }
}

# FSTR — Deploy to Vercel (Step by Step)

## What you need
- A free GitHub account → github.com
- A free Vercel account → vercel.com
- Your free Gemini API key → aistudio.google.com/app/apikey

---

## Step 1 — Upload to GitHub

1. Go to github.com → click **New repository**
2. Name it `fstr-app` → click **Create repository**
3. Upload these files (drag and drop):
   - `vercel.json`
   - `package.json`
   - `api/analyse.js`
   - `public/index.html`

---

## Step 2 — Deploy on Vercel

1. Go to vercel.com → Sign up with GitHub
2. Click **Add New Project**
3. Select your `fstr-app` repository
4. Click **Deploy** — wait 60 seconds

---

## Step 3 — Add your API key (the important bit)

1. In Vercel → go to your project → **Settings → Environment Variables**
2. Add this:
   - **Name:** `GEMINI_API_KEY`
   - **Value:** your key from aistudio.google.com (starts with AIza...)
3. Click **Save**
4. Go to **Deployments** → click **Redeploy**

---

## Step 4 — Done

Vercel gives you a live link like:
`https://fstr-app.vercel.app`

Share this link with anyone. They paste a YouTube link and get results instantly.
No API key visible. No sign up required for users.

---

## Security built in
- API key is hidden server-side — never visible in browser
- Rate limiting: 10 requests per IP per minute
- Only YouTube URLs accepted — all other inputs rejected
- Google's safety filters enabled on all AI responses
- No user data stored anywhere

# AntForMail v1.0 — Self-Hosted Email Forwarding Micro-SaaS

A centralized email forwarding service for all your web projects. Each project gets its own API key. Form submissions are forwarded to configurable email addresses. Dashboard shows all submissions.

## One-Click Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/antkkds/antformail)

Click the button above → connect GitHub → done. (Free tier: 750 hours/month)

After deploy:
1. Open your Render URL → complete the **Setup Wizard** (set password)
2. Go to **Projects** → **Add Project** → name it, set forwarding email
3. Copy the API key → paste into your website's contact form

## Integration

Add this to any website's contact form:

```javascript
fetch('https://YOUR-RENDER-URL.onrender.com/api/submit', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'YOUR_PROJECT_API_KEY'
  },
  body: JSON.stringify({
    name: form.name,
    email: form.email,
    message: form.message,
    phone: form.phone
  })
});
```

## Quick Start (Local)

```bash
git clone https://github.com/antkkds/antformail.git
cd antformail
npm install
node server.js
# → http://localhost:3457
```

## Features

- **Multiple Projects** — Each website gets its own API key
- **Central Dashboard** — View all submissions in one place
- **SQLite Storage** — No external database needed
- **Self-Hosted** — Your data, your server
- **SMTP Support** — Configure Gmail, SendGrid, or any SMTP
- **Free to Deploy** — Render free tier handles it

## File Structure

```
antformail/
├── server.js          — Express API + dashboard
├── public/index.html  — Dashboard frontend
├── render.yaml        — Render deploy config
├── Dockerfile         — Container deployment
└── data/              — Auto-created SQLite DB
```

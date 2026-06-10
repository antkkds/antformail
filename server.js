const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── Database Setup ──
let db;
try {
  const Database = require('better-sqlite3');
  db = new Database(path.join(__dirname, 'data', 'antformail.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (e) {
  console.error('❌ better-sqlite3 not found. Run: npm install');
  process.exit(1);
}

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    forward_email TEXT NOT NULL,
    website_url TEXT DEFAULT '',
    api_key TEXT UNIQUE NOT NULL,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT DEFAULT '',
    message TEXT NOT NULL,
    ip TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    forwarded INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id)
  );
`);

// ── Helpers ──
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function getConfig() {
  const rows = db.prepare('SELECT key, value FROM config').all();
  const config = {};
  for (const row of rows) config[row.key] = row.value;
  return config;
}

function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
}

function generateApiKey() {
  return 'afm_' + crypto.randomBytes(24).toString('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── SMTP / Email ──
async function sendEmail(to, subject, body, replyTo) {
  const config = getConfig();
  
  if (config.smtp_host && config.smtp_user && config.smtp_pass) {
    // SMTP mode
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: parseInt(config.smtp_port || '587'),
      secure: config.smtp_secure === 'true',
      auth: { user: config.smtp_user, pass: config.smtp_pass },
    });
    await transporter.sendMail({
      from: `"${config.instance_name || 'AntForMail'}" <${config.smtp_user}>`,
      to,
      subject,
      text: body,
      replyTo: replyTo || config.smtp_user,
    });
  } else {
    // No SMTP configured — log to console
    console.log('📩 Email would be sent (no SMTP):');
    console.log(`  To: ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body: ${body.substring(0, 100)}...`);
  }
}

// ── Auth Middleware ──
function requireAuth(req, res, next) {
  const config = getConfig();
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  const validTokens = db.prepare('SELECT value FROM config WHERE key = ?').all('session_tokens');
  const isValid = validTokens.some(t => t.value === token);
  
  if (!config.setup_done) return next(); // Allow setup
  if (!isValid) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

// ================================================================
// API ROUTES
// ================================================================

// ── Health Check ──
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'AntForMail', version: '1.0.0' });
});

// ── Setup Wizard ──
app.post('/api/setup', (req, res) => {
  const { instance_name, admin_email, password, smtp_host, smtp_port, smtp_user, smtp_pass } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
  }
  
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  setConfig('admin_password_hash', hash);
  setConfig('instance_name', instance_name || 'AntForMail');
  setConfig('admin_email', admin_email || '');
  if (smtp_host) setConfig('smtp_host', smtp_host);
  if (smtp_port) setConfig('smtp_port', smtp_port);
  if (smtp_user) setConfig('smtp_user', smtp_user);
  if (smtp_pass) setConfig('smtp_pass', smtp_pass);
  setConfig('setup_done', 'true');
  
  const token = generateToken();
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('session_tokens', token);
  
  res.json({ ok: true, token, message: 'Setup complete!' });
});

// ── Login ──
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const config = getConfig();
  const hash = crypto.createHash('sha256').update(password || '').digest('hex');
  
  if (hash !== config.admin_password_hash) {
    return res.status(401).json({ ok: false, error: 'Wrong password' });
  }
  
  const token = generateToken();
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('session_tokens', token);
  res.json({ ok: true, token });
});

// ── Dashboard Data ──
app.get('/api/data', requireAuth, (req, res) => {
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  const submissions = db.prepare(`
    SELECT s.*, p.name as project_name 
    FROM submissions s 
    JOIN projects p ON s.project_id = p.id 
    ORDER BY s.created_at DESC 
    LIMIT 200
  `).all();
  
  const config = getConfig();
  const stats = {
    total_projects: projects.length,
    total_submissions: db.prepare('SELECT COUNT(*) as c FROM submissions').get().c,
    forwarded: db.prepare('SELECT COUNT(*) as c FROM submissions WHERE forwarded = 1').get().c,
    pending: db.prepare('SELECT COUNT(*) as c FROM submissions WHERE forwarded = 0').get().c,
  };
  
  res.json({
    ok: true,
    config: { instance_name: config.instance_name, admin_email: config.admin_email, setup_done: config.setup_done },
    projects,
    submissions,
    stats,
    version: '1.0.0',
  });
});

// ── Projects CRUD ──
app.get('/api/projects', requireAuth, (req, res) => {
  const projects = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  res.json({ ok: true, projects });
});

app.post('/api/projects', requireAuth, (req, res) => {
  const { name, forward_email, website_url } = req.body;
  if (!name || !forward_email) {
    return res.status(400).json({ ok: false, error: 'Name and forward email required' });
  }
  
  const project = {
    id: 'proj_' + crypto.randomBytes(8).toString('hex'),
    name,
    forward_email,
    website_url: website_url || '',
    api_key: generateApiKey(),
    active: 1,
    created_at: new Date().toISOString(),
  };
  
  db.prepare('INSERT INTO projects (id, name, forward_email, website_url, api_key, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(project.id, project.name, project.forward_email, project.website_url, project.api_key, project.active, project.created_at);
  
  res.json({ ok: true, project });
});

app.put('/api/projects/:id', requireAuth, (req, res) => {
  const { name, forward_email, website_url, active } = req.body;
  db.prepare('UPDATE projects SET name = COALESCE(?, name), forward_email = COALESCE(?, forward_email), website_url = COALESCE(?, website_url), active = COALESCE(?, active) WHERE id = ?')
    .run(name || null, forward_email || null, website_url || null, active !== undefined ? (active ? 1 : 0) : null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/projects/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM submissions WHERE project_id = ?').run(req.params.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── Regenerate API Key ──
app.post('/api/projects/:id/regenerate-key', requireAuth, (req, res) => {
  const newKey = generateApiKey();
  db.prepare('UPDATE projects SET api_key = ? WHERE id = ?').run(newKey, req.params.id);
  res.json({ ok: true, api_key: newKey });
});

// ── Submit Form (Public) ──
app.post('/api/submit', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.body.api_key;
  const project = db.prepare('SELECT * FROM projects WHERE api_key = ? AND active = 1').get(apiKey);
  
  if (!project) {
    return res.status(401).json({ ok: false, error: 'Invalid API key' });
  }
  
  const { name, email, message, phone } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ ok: false, error: 'Name, email and message required' });
  }
  
  const submission = {
    id: 'msg_' + crypto.randomBytes(12).toString('hex'),
    project_id: project.id,
    name,
    email,
    phone: phone || '',
    message,
    ip: req.ip || req.socket.remoteAddress || '',
    user_agent: req.headers['user-agent'] || '',
    forwarded: 0,
    created_at: new Date().toISOString(),
  };
  
  db.prepare('INSERT INTO submissions (id, project_id, name, email, phone, message, ip, user_agent, forwarded, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(submission.id, submission.project_id, submission.name, submission.email, submission.phone, submission.message, submission.ip, submission.user_agent, submission.forwarded, submission.created_at);
  
  // Forward email
  try {
    const subject = `[${project.name}] New enquiry from ${name}`;
    const body = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n  New Contact Form Submission\n  Project: ${project.name}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n  Name:    ${name}\n  Email:   ${email}\n${phone ? `  Phone:   ${phone}\n` : ''}\n  Message:\n  ${message}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n  IP: ${submission.ip}\n  Time: ${submission.created_at}\n  Sent via AntForMail\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    
    await sendEmail(project.forward_email, subject, body, email);
    db.prepare('UPDATE submissions SET forwarded = 1 WHERE id = ?').run(submission.id);
    submission.forwarded = 1;
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
  
  res.json({ ok: true, message: 'Message received! We will get back to you soon.' });
});

// ── Get Submissions for a Project ──
app.get('/api/submissions/:projectId', requireAuth, (req, res) => {
  const subs = db.prepare('SELECT * FROM submissions WHERE project_id = ? ORDER BY created_at DESC').all(req.params.projectId);
  res.json({ ok: true, submissions: subs });
});

// ── Update Config ──
app.post('/api/config', requireAuth, (req, res) => {
  const allowed = ['instance_name', 'admin_email', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_secure'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) setConfig(key, req.body[key]);
  }
  if (req.body.new_password && req.body.new_password.length >= 6) {
    const hash = crypto.createHash('sha256').update(req.body.new_password).digest('hex');
    setConfig('admin_password_hash', hash);
  }
  res.json({ ok: true, message: 'Settings saved!' });
});

// ── Check if setup is done ──
app.get('/api/status', (req, res) => {
  const config = getConfig();
  res.json({ ok: true, setup_done: !!config.setup_done });
});

// ================================================================
// STATIC DASHBOARD
// ================================================================
app.use(express.static(path.join(__dirname, 'public')));

// Serve dashboard for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ================================================================
// START
// ================================================================
const PORT = process.env.PORT || 3457;
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  📬 AntForMail v1.0');
  console.log('  ───────────────────────────────');
  console.log(`  Dashboard: http://localhost:${PORT}/`);
  console.log(`  API:       http://localhost:${PORT}/api/`);
  console.log('  ───────────────────────────────');
  console.log('  Run anywhere: VPS, Railway, Render, Fly.io');
  console.log('');
});

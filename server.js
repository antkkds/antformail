const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── Database Setup (sql.js — pure JS, no native compilation) ──
let db;
let dbRaw; // Reference to the raw SQL.Database instance
const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DB_DIR, 'antformail.db');

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// If there's an existing DB but it might be corrupt from previous failed deployment
if (fs.existsSync(DB_PATH)) {
  try {
    const testBuffer = fs.readFileSync(DB_PATH);
    // Check if it's a valid SQLite database (starts with SQLite format header)
    if (testBuffer.length < 100 || !testBuffer.toString('utf-8', 0, 16).includes('SQLite')) {
      console.log('⚠️ Existing database is corrupt or not valid SQLite. Resetting...');
      fs.unlinkSync(DB_PATH);
    }
  } catch (e) {
    console.log('⚠️ Cannot read existing database. Resetting...');
    fs.unlinkSync(DB_PATH);
  }
}
const INIT_SQL = `
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
    created_at TEXT DEFAULT (datetime('now'))
  );
`;

function initDb() {
  const initSqlJs = require('sql.js');
  const wasmPath = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new (require('sql.js'))(buffer);
  } else {
    db = new (require('sql.js'))();
    db.run('PRAGMA journal_mode=WAL');
  }
  
  db.run(INIT_SQL);
  saveDb();
}

function saveDb() {
  if (!dbRaw) return;
  try {
    const data = dbRaw.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (e) {
    console.error('Failed to save database:', e.message);
  }
}

// Wrap sql.js to have synchronous API like better-sqlite3
db = {
  _run: null,
  _exec: null,
  prepare(sql) {
    return {
      run: (...params) => {
        db._run(sql, params);
        saveDb();
      },
      get: (...params) => db._get(sql, params),
      all: (...params) => db._all(sql, params),
    };
  },
  run: function(sql, params = []) {
    this._run(sql, params);
    saveDb();
  },
  exec: function(sql) {
    this._exec(sql);
    saveDb();
  },
};

try {
  const initSqlJs = require('sql.js');
  const wasmPath = path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  
  let sqlBuffer;
  if (fs.existsSync(DB_PATH)) {
    sqlBuffer = fs.readFileSync(DB_PATH);
  }
  
  initSqlJs({ locateFile: () => wasmPath }).then((SQL) => {
    const rawDb = sqlBuffer ? new SQL.Database(sqlBuffer) : new SQL.Database();
    dbRaw = rawDb; // Store reference for saveDb()
    
    // Run initialization
    rawDb.run(INIT_SQL);
    rawDb.run("PRAGMA journal_mode=WAL");
    
    // Save initial state
    if (!sqlBuffer) {
      fs.writeFileSync(DB_PATH, Buffer.from(rawDb.export()));
    }
    
    // Map methods
    db._run = (sql, params) => {
      try { rawDb.run(sql, params); } catch(e) { console.error('DB error:', sql, e.message); }
    };
    db._get = (sql, params) => {
      try {
        const stmt = rawDb.prepare(sql);
        stmt.bind(params);
        if (stmt.step()) {
          const cols = stmt.getColumnNames();
          const vals = stmt.get();
          stmt.free();
          const row = {};
          cols.forEach((c, i) => row[c] = vals[i]);
          return row;
        }
        stmt.free();
        return null;
      } catch(e) { return null; }
    };
    db._all = (sql, params) => {
      try {
        const stmt = rawDb.prepare(sql);
        stmt.bind(params);
        const rows = [];
        const cols = stmt.getColumnNames();
        while (stmt.step()) {
          const vals = stmt.get();
          const row = {};
          cols.forEach((c, i) => row[c] = vals[i]);
          rows.push(row);
        }
        stmt.free();
        return rows;
      } catch(e) { return []; }
    };
    db._exec = (sql) => { try { rawDb.run(sql); } catch(e) {} };
    
    // Auto-save periodically
    setInterval(() => {
      try {
        fs.writeFileSync(DB_PATH, Buffer.from(dbRaw.export()));
      } catch(e) {}
    }, 5000);
    
    console.log('✅ SQLite database ready (sql.js)');
    startServer();
  }).catch(err => {
    console.error('❌ Failed to init database:', err.message);
    process.exit(1);
  });
} catch (err) {
  console.error('❌ Failed to load sql.js:', err.message);
  console.error('   Run: npm install');
  process.exit(1);
}

// ── Express App ──
const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, GET, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function getConfig() {
  const rows = db._all('SELECT key, value FROM config');
  const config = {};
  for (const row of rows) config[row.key] = row.value;
  return config;
}

function setConfig(key, value) {
  db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, String(value)]);
}

function generateApiKey() {
  return 'afm_' + crypto.randomBytes(24).toString('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function startServer() {
  
  // ── Health ──
  app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'AntForMail', version: '1.0.0' });
  });

  // ── Setup ──
  app.post('/api/setup', (req, res) => {
    const { instance_name, admin_email, password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ ok: false, error: 'Password must be at least 6 characters' });
    }
    
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    setConfig('admin_password_hash', hash);
    setConfig('instance_name', instance_name || 'AntForMail');
    setConfig('admin_email', admin_email || '');
    setConfig('setup_done', 'true');
    
    const token = generateToken();
    db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['session_tokens', token]);
    
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
    db.run('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', ['session_tokens', token]);
    res.json({ ok: true, token });
  });

  // ── Auth middleware ──
  function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    const tokens = db._all('SELECT value FROM config WHERE key = ?', ['session_tokens']);
    const isValid = tokens.some(t => t.value === token);
    
    if (!getConfig().setup_done) return next();
    if (!isValid) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    next();
  }

  // ── Dashboard data ──
  app.get('/api/data', requireAuth, (req, res) => {
    const projects = db._all('SELECT * FROM projects ORDER BY created_at DESC');
    const submissions = db._all(`
      SELECT s.*, p.name as project_name 
      FROM submissions s 
      JOIN projects p ON s.project_id = p.id 
      ORDER BY s.created_at DESC 
      LIMIT 200
    `);
    
    const config = getConfig();
    const stats = {
      total_projects: projects.length,
      total_submissions: (db._get('SELECT COUNT(*) as c FROM submissions') || {}).c || 0,
      forwarded: (db._get('SELECT COUNT(*) as c FROM submissions WHERE forwarded = 1') || {}).c || 0,
      pending: (db._get('SELECT COUNT(*) as c FROM submissions WHERE forwarded = 0') || {}).c || 0,
    };
    
    res.json({
      ok: true,
      config: { instance_name: config.instance_name, admin_email: config.admin_email, setup_done: config.setup_done },
      projects, submissions, stats, version: '1.0.0',
    });
  });

  // ── Projects CRUD ──
  app.get('/api/projects', requireAuth, (req, res) => {
    res.json({ ok: true, projects: db._all('SELECT * FROM projects ORDER BY created_at DESC') });
  });

  app.post('/api/projects', requireAuth, (req, res) => {
    const { name, forward_email, website_url } = req.body;
    if (!name || !forward_email) {
      return res.status(400).json({ ok: false, error: 'Name and forward email required' });
    }
    
    const project = {
      id: 'proj_' + crypto.randomBytes(8).toString('hex'),
      name, forward_email,
      website_url: website_url || '',
      api_key: generateApiKey(),
      active: 1,
      created_at: new Date().toISOString(),
    };
    
    db.run('INSERT INTO projects (id, name, forward_email, website_url, api_key, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [project.id, project.name, project.forward_email, project.website_url, project.api_key, project.active, project.created_at]);
    
    res.json({ ok: true, project });
  });

  app.delete('/api/projects/:id', requireAuth, (req, res) => {
    db.run('DELETE FROM submissions WHERE project_id = ?', [req.params.id]);
    db.run('DELETE FROM projects WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });

  app.post('/api/projects/:id/regenerate-key', requireAuth, (req, res) => {
    const newKey = generateApiKey();
    db.run('UPDATE projects SET api_key = ? WHERE id = ?', [newKey, req.params.id]);
    res.json({ ok: true, api_key: newKey });
  });

  // ── Submit Form ──
  app.post('/api/submit', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.body.api_key;
    const project = db._get('SELECT * FROM projects WHERE api_key = ? AND active = 1', [apiKey]);
    
    if (!project) {
      return res.status(401).json({ ok: false, error: 'Invalid API key' });
    }
    
    const { name, email, message, phone } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ ok: false, error: 'Name, email and message required' });
    }
    
    const submission = {
      id: 'msg_' + crypto.randomBytes(12).toString('hex'),
      project_id: project.id, name, email,
      phone: phone || '', message,
      ip: req.ip || req.socket.remoteAddress || '',
      user_agent: req.headers['user-agent'] || '',
      forwarded: 0,
      created_at: new Date().toISOString(),
    };
    
    db.run('INSERT INTO submissions (id, project_id, name, email, phone, message, ip, user_agent, forwarded, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [submission.id, submission.project_id, submission.name, submission.email, submission.phone, submission.message, submission.ip, submission.user_agent, submission.forwarded, submission.created_at]);
    
    // Forward email (try without SMTP)
    try {
      const subject = `[${project.name}] New enquiry from ${name}`;
      const body = `New Contact Form Submission\nProject: ${project.name}\n\nName: ${name}\nEmail: ${email}${phone ? `\nPhone: ${phone}` : ''}\n\nMessage:\n${message}\n\n---\nIP: ${submission.ip}\nTime: ${submission.created_at}\nSent via AntForMail`;
      
      const nodemailer = require('nodemailer');
      const config = getConfig();
      
      if (config.smtp_host && config.smtp_user && config.smtp_pass) {
        const transporter = nodemailer.createTransport({
          host: config.smtp_host,
          port: parseInt(config.smtp_port || '587'),
          secure: config.smtp_secure === 'true',
          auth: { user: config.smtp_user, pass: config.smtp_pass },
        });
        await transporter.sendMail({
          from: `"${config.instance_name || 'AntForMail'}" <${config.smtp_user}>`,
          to: project.forward_email,
          subject, text: body,
          replyTo: email,
        });
        db.run('UPDATE submissions SET forwarded = 1 WHERE id = ?', [submission.id]);
        submission.forwarded = 1;
      } else {
        console.log('📩 Would forward email (no SMTP):', project.forward_email, subject);
      }
    } catch (err) {
      console.error('Email forward failed:', err.message);
    }
    
    res.json({ ok: true, message: 'Message received! We will get back to you soon.' });
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

  app.get('/api/status', (req, res) => {
    res.json({ ok: true, setup_done: !!getConfig().setup_done });
  });

  // ── Static dashboard ──
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // ── Start ──
  const PORT = process.env.PORT || 3457;
  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  📬 AntForMail v1.0');
    console.log('  ───────────────────────────────');
    console.log(`  Dashboard: http://localhost:${PORT}/`);
    console.log(`  API:       http://localhost:${PORT}/api/`);
    console.log('  ───────────────────────────────');
    console.log(`  DB: ${DB_PATH}`);
    console.log('');
  });
}

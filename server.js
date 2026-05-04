/**
 * server.js — Témoigne de moi v2
 * Serveur Express unique gérant audio, vidéo, écrit et feedback
 * Portable : toute la configuration vient de .env ou de l'admin
 */
require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const { Resend } = require('resend');
const { getConfig, setConfig } = require('./config');

const app  = express();
const port = process.env.PORT || 3000;

// ── Multer — 500 MB max en mémoire ────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 500 * 1024 * 1024 },
});


// ── Static + JSON ─────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, version: '2.0.0' }));

// ── Pages SPA ─────────────────────────────────────────────────────
const page = (f) => (_, res) => res.sendFile(path.join(__dirname, 'public', f));
app.get('/',          page('index.html'));
app.get('/audio',     page('audio.html'));
app.get('/video',     page('video.html'));
app.get('/ecrit',     page('ecrit.html'));
app.get('/feedback',  page('feedback.html'));
app.get('/admin',     page('admin.html'));

// ── Config publique (sans données sensibles) ──────────────────────
app.get('/api/config', (_, res) => {
  const cfg = getConfig();
  res.json({
    appTitle:       cfg.appTitle,
    appSubtitle:    cfg.appSubtitle,
    tinymceKey:     cfg.tinymceKey,
    audioPrefix:    cfg.audioPrefix,
    videoSizeMb:    cfg.videoSizeMb,
    badgeText:      cfg.badgeText,
    heroTitle:      cfg.heroTitle,
    logoDataUrl:    cfg.logoDataUrl,
    croixCardTitle: cfg.croixCardTitle,
    croixCardTag:   cfg.croixCardTag,
    croixCardDesc:  cfg.croixCardDesc,
    croixCardUrl:   cfg.croixCardUrl,
  });
});

// ── Admin : lire config complète (protégée) ───────────────────────
app.get('/api/admin/config', requireAdmin, (_, res) => {
  const cfg = getConfig();
  // Ne jamais exposer la clé Resend
  const { adminPassword, ...safe } = cfg;
  res.json(safe);
});

// ── Admin : modifier config ───────────────────────────────────────
app.post('/api/admin/config', requireAdmin, (req, res) => {
  const allowed = [
    'destEmail','fromEmail','fromName',
    'appTitle','appSubtitle','footerText',
    'tinymceKey','audioPrefix','adminPassword',
    'badgeText','heroTitle','logoDataUrl',
    'croixCardTitle','croixCardTag','croixCardDesc','croixCardUrl',
    // Seuils
    'audioSizeMb','videoSizeMb','ecritSizeMb',
    // Stockage distant
    'storageType',
    'gdriveFolder','gdriveJson',
    'ftpHost','ftpPort','ftpUser','ftpPassword','ftpPath','ftpPublicUrl',
    'webhookUrl','webhookSecret',
  ];
  const updates = {};
  allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });

  if (updates.destEmail && !updates.destEmail.includes('@'))
    return res.status(400).json({ ok: false, error: 'Email invalide.' });

  // Forcer les seuils en entiers
  ['audioSizeMb','videoSizeMb','ecritSizeMb'].forEach(k => {
    if (updates[k]) updates[k] = parseInt(updates[k]) || 10;
  });

  const updated = setConfig(updates);
  console.log('⚙️  Config mise à jour — stockage:', updated.storageType);
  res.json({ ok: true, config: updated });
});

// ══════════════════════════════════════════════════════════════════
// STOCKAGE DISTANT — uploadToStorage(buffer, filename, mime)
// Retourne { url } ou lève une erreur
// ══════════════════════════════════════════════════════════════════
async function uploadToStorage(buffer, filename, mime) {
  const cfg = getConfig();

  // ── Google Drive ──────────────────────────────────────────────
  if (cfg.storageType === 'gdrive') {
    const { google } = require('googleapis');
    const credentials = JSON.parse(cfg.gdriveJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    });
    const drive = google.drive({ version: 'v3', auth });
    const { data: file } = await drive.files.create({
      requestBody: {
        name:    filename,
        parents: cfg.gdriveFolder ? [cfg.gdriveFolder] : [],
      },
      media: { mimeType: mime, body: require('stream').Readable.from(buffer) },
      fields: 'id, webViewLink',
    });
    await drive.permissions.create({
      fileId:      file.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });
    return { url: file.webViewLink };
  }

  // ── FTP / SFTP ────────────────────────────────────────────────
  if (cfg.storageType === 'ftp') {
    const ftp = require('basic-ftp');
    const client = new ftp.Client();
    client.ftp.verbose = false;
    try {
      await client.access({
        host:     cfg.ftpHost,
        port:     parseInt(cfg.ftpPort) || 21,
        user:     cfg.ftpUser,
        password: cfg.ftpPassword,
        secure:   false,
      });
      const remotePath = `${cfg.ftpPath || '/uploads'}/${filename}`;
      const { Readable } = require('stream');
      await client.uploadFrom(Readable.from(buffer), remotePath);
      const publicUrl = cfg.ftpPublicUrl
        ? `${cfg.ftpPublicUrl.replace(/\/$/, '')}/${filename}`
        : `ftp://${cfg.ftpHost}${remotePath}`;
      return { url: publicUrl };
    } finally {
      client.close();
    }
  }

  // ── Webhook (POST multipart) ───────────────────────────────────
  if (cfg.storageType === 'webhook') {
    const FormData = require('form-data');
    const fetch    = require('node-fetch');
    const form = new FormData();
    form.append('file', buffer, { filename, contentType: mime });
    if (cfg.webhookSecret) form.append('secret', cfg.webhookSecret);
    const res  = await fetch(cfg.webhookUrl, { method: 'POST', body: form });
    const json = await res.json();
    if (!json.url && !json.link && !json.fileUrl)
      throw new Error('Webhook : aucune URL retournée dans la réponse.');
    return { url: json.url || json.link || json.fileUrl };
  }

  throw new Error('Aucun stockage configuré ou type inconnu : ' + cfg.storageType);
}

// ── Middleware auth admin ─────────────────────────────────────────
function requireAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.query.pwd;
  if (pwd === getConfig().adminPassword) return next();
  res.status(401).json({ ok: false, error: 'Mot de passe incorrect.' });
}

// ══════════════════════════════════════════════════════════════════
// ENVOI AUDIO
// ══════════════════════════════════════════════════════════════════
app.post('/api/send/audio', upload.single('audio'), async (req, res) => {
  try {
    const cfg       = getConfig();
    const threshold = (cfg.audioSizeMb || 10) * 1024 * 1024;
    if (!cfg.destEmail) return res.status(500).json({ ok: false, error: 'Email non configuré → /admin' });
    if (!req.file)      return res.status(400).json({ ok: false, error: 'Aucun fichier audio.' });

    const filename = req.body.filename || `vocal_${Date.now()}.webm`;
    const sender   = req.body.sender   || 'Anonyme';
    const date     = req.body.date     || now();
    const duration = req.body.duration || '?';
    const mime     = getMimeAudio(filename);
    const sizeMb   = (req.file.size / 1024 / 1024).toFixed(1);
    const resend   = new Resend(process.env.RESEND_API_KEY);

    if (req.file.size <= threshold || cfg.storageType === 'none') {
      const { data, error } = await resend.emails.send({
        from:    `${cfg.fromName} <${cfg.fromEmail}>`,
        to:      [cfg.destEmail],
        subject: `🎙 Témoignage vocal — ${sender}`,
        html:    emailHtml({ icon:'🎙', color:'#E8825A', type:'Témoignage vocal', sender, date, filename,
          extra:`<tr><td style="padding:8px 0;color:#888;">Durée</td><td style="padding:8px 0;">${esc(duration)}</td></tr><tr><td style="padding:8px 0;color:#888;">Taille</td><td style="padding:8px 0;">${sizeMb} MB</td></tr>`,
          note:'📎 Fichier audio en pièce jointe.', appTitle:cfg.appTitle, footer:cfg.footerText }),
        text:    `Témoignage vocal de ${sender}\nDate : ${date}\nDurée : ${duration}\nFichier : ${filename}`,
        attachments: [{ filename, content: req.file.buffer.toString('base64'), contentType: mime }],
      });
      if (error) throw new Error(error.message);
      console.log(`🎙 Audio joint [${data.id}] de ${sender}`);
      res.json({ ok: true, method: 'attachment' });
    } else {
      console.log(`☁️  Audio ${sizeMb} MB > ${cfg.audioSizeMb} MB → ${cfg.storageType}`);
      const { url } = await uploadToStorage(req.file.buffer, filename, mime);
      const { data, error } = await resend.emails.send({
        from:    `${cfg.fromName} <${cfg.fromEmail}>`,
        to:      [cfg.destEmail],
        subject: `🎙 Témoignage vocal (${sizeMb} MB) — ${sender}`,
        html:    emailHtml({ icon:'🎙', color:'#E8825A', type:'Témoignage vocal', sender, date, filename,
          extra:`<tr><td style="padding:8px 0;color:#888;">Durée</td><td style="padding:8px 0;">${esc(duration)}</td></tr><tr><td style="padding:8px 0;color:#888;">Taille</td><td style="padding:8px 0;">${sizeMb} MB</td></tr>`,
          note:'', link: url, appTitle:cfg.appTitle, footer:cfg.footerText }),
        text:    `Témoignage vocal de ${sender}\nDate : ${date}\nDurée : ${duration}\nTaille : ${sizeMb} MB\nFichier : ${url}`,
      });
      if (error) throw new Error(error.message);
      console.log(`🎙 Audio cloud [${data.id}] → ${url}`);
      res.json({ ok: true, method: 'cloud', url });
    }
  } catch(e) { console.error(e); res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ENVOI VIDÉO
// ══════════════════════════════════════════════════════════════════
app.post('/api/send/video', upload.single('video'), async (req, res) => {
  try {
    const cfg       = getConfig();
    const threshold = (cfg.videoSizeMb || 25) * 1024 * 1024;
    if (!cfg.destEmail) return res.status(500).json({ ok: false, error: 'Email non configuré → /admin' });
    if (!req.file)      return res.status(400).json({ ok: false, error: 'Aucune vidéo.' });

    const filename = req.body.filename || `video_${Date.now()}.webm`;
    const sender   = req.body.sender   || 'Anonyme';
    const date     = req.body.date     || now();
    const duration = req.body.duration || '?';
    const sizeMb   = (req.file.size / 1024 / 1024).toFixed(1);
    const mime     = getMimeVideo(filename);
    const resend   = new Resend(process.env.RESEND_API_KEY);

    if (req.file.size <= threshold || cfg.storageType === 'none') {
      const { data, error } = await resend.emails.send({
        from:    `${cfg.fromName} <${cfg.fromEmail}>`,
        to:      [cfg.destEmail],
        subject: `🎥 Témoignage vidéo — ${sender}`,
        html:    emailHtml({ icon:'🎥', color:'#5B8DB8', type:'Témoignage vidéo', sender, date, filename,
          extra:`<tr><td style="padding:8px 0;color:#888;">Durée</td><td style="padding:8px 0;">${esc(duration)}</td></tr><tr><td style="padding:8px 0;color:#888;">Taille</td><td style="padding:8px 0;">${sizeMb} MB</td></tr>`,
          note:'📎 Vidéo en pièce jointe.', appTitle:cfg.appTitle, footer:cfg.footerText }),
        text:    `Témoignage vidéo de ${sender}\nDate : ${date}\nDurée : ${duration}\nTaille : ${sizeMb} MB`,
        attachments: [{ filename, content: req.file.buffer.toString('base64'), contentType: mime }],
      });
      if (error) throw new Error(error.message);
      console.log(`🎥 Vidéo joint [${data.id}] de ${sender}`);
      res.json({ ok: true, method: 'attachment' });
    } else {
      console.log(`☁️  Vidéo ${sizeMb} MB > ${cfg.videoSizeMb} MB → ${cfg.storageType}`);
      const { url } = await uploadToStorage(req.file.buffer, filename, mime);
      const { data, error } = await resend.emails.send({
        from:    `${cfg.fromName} <${cfg.fromEmail}>`,
        to:      [cfg.destEmail],
        subject: `🎥 Témoignage vidéo (${sizeMb} MB) — ${sender}`,
        html:    emailHtml({ icon:'🎥', color:'#5B8DB8', type:'Témoignage vidéo', sender, date, filename,
          extra:`<tr><td style="padding:8px 0;color:#888;">Durée</td><td style="padding:8px 0;">${esc(duration)}</td></tr><tr><td style="padding:8px 0;color:#888;">Taille</td><td style="padding:8px 0;">${sizeMb} MB</td></tr>`,
          note:'', link: url, appTitle:cfg.appTitle, footer:cfg.footerText }),
        text:    `Témoignage vidéo de ${sender}\nDate : ${date}\nDurée : ${duration}\nTaille : ${sizeMb} MB\nFichier : ${url}`,
      });
      if (error) throw new Error(error.message);
      console.log(`🎥 Vidéo cloud [${data.id}] → ${url}`);
      res.json({ ok: true, method: 'cloud', url });
    }
  } catch(e) { console.error(e); res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ENVOI ÉCRIT
// ══════════════════════════════════════════════════════════════════
app.post('/api/send/ecrit', async (req, res) => {
  try {
    const cfg = getConfig();
    if (!cfg.destEmail) return res.status(500).json({ ok: false, error: 'Email non configuré → /admin' });

    const { sender, subject, htmlContent, textContent } = req.body;
    if (!htmlContent?.trim()) return res.status(400).json({ ok: false, error: 'Contenu vide.' });

    const resend    = new Resend(process.env.RESEND_API_KEY);
    const textBuf   = Buffer.from(textContent || '', 'utf8');
    const sizeMb    = (textBuf.length / 1024 / 1024).toFixed(2);
    const threshold = (cfg.ecritSizeMb || 5) * 1024 * 1024;

    if (textBuf.length <= threshold || cfg.storageType === 'none') {
      const { data, error } = await resend.emails.send({
        from:    `${cfg.fromName} <${cfg.fromEmail}>`,
        to:      [cfg.destEmail],
        subject: `✍️ Témoignage écrit — ${subject || 'Sans titre'}`,
        html:    emailHtml({ icon:'✍️', color:'#6BAE8E', type:'Témoignage écrit',
          sender: sender||'Anonyme', date: now(), filename: subject||'Sans titre',
          extra:'', note: htmlContent, raw: true, appTitle:cfg.appTitle, footer:cfg.footerText }),
        text:    `Témoignage écrit de ${sender||'Anonyme'}\n${subject ? 'Titre : '+subject+'\n' : ''}\n${textContent}`,
      });
      if (error) throw new Error(error.message);
      console.log(`✍️ Écrit [${data.id}] de ${sender}`);
      res.json({ ok: true, method: 'email' });
    } else {
      console.log(`☁️  Écrit ${sizeMb} MB > ${cfg.ecritSizeMb} MB → ${cfg.storageType}`);
      const filename = `ecrit_${Date.now()}.html`;
      const { url } = await uploadToStorage(Buffer.from(htmlContent, 'utf8'), filename, 'text/html');
      const { data, error } = await resend.emails.send({
        from:    `${cfg.fromName} <${cfg.fromEmail}>`,
        to:      [cfg.destEmail],
        subject: `✍️ Témoignage écrit (${sizeMb} MB) — ${subject || 'Sans titre'}`,
        html:    emailHtml({ icon:'✍️', color:'#6BAE8E', type:'Témoignage écrit',
          sender: sender||'Anonyme', date: now(), filename: subject||'Sans titre',
          extra:'', note:'', link: url, appTitle:cfg.appTitle, footer:cfg.footerText }),
        text:    `Témoignage écrit de ${sender||'Anonyme'}\nDocument disponible : ${url}`,
      });
      if (error) throw new Error(error.message);
      console.log(`✍️ Écrit cloud [${data.id}] → ${url}`);
      res.json({ ok: true, method: 'cloud', url });
    }
  } catch(e) { console.error(e); res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ENVOI FEEDBACK
// ══════════════════════════════════════════════════════════════════
app.post('/api/send/feedback', async (req, res) => {
  try {
    const cfg = getConfig();
    if (!cfg.destEmail) return res.status(500).json({ ok: false, error: 'Email non configuré.' });

    const { sender, type, note, satisfaction, amelioration } = req.body;
    if (!note) return res.status(400).json({ ok: false, error: 'Note manquante.' });

    const stars    = '★'.repeat(parseInt(note)) + '☆'.repeat(5 - parseInt(note));
    const satMap   = { tres_satisfait:'😊 Très satisfait', satisfait:'🙂 Satisfait', neutre:'😐 Neutre', insatisfait:'😕 Insatisfait', tres_insatisfait:'😞 Très insatisfait' };
    const typeMap  = { audio:'🎙 Audio', video:'🎥 Vidéo', ecrit:'✍️ Écrit' };
    const satLabel = satMap[satisfaction] || satisfaction;
    const typeLabel= typeMap[type] || type;

    const extra = `
      <tr><td style="padding:8px 0;color:#888;">Type</td><td style="padding:8px 0;font-weight:600;">${esc(typeLabel)}</td></tr>
      <tr><td style="padding:8px 0;color:#888;">Note</td><td style="padding:8px 0;color:#E8825A;font-size:18px;letter-spacing:2px;">${stars} ${note}/5</td></tr>
      <tr><td style="padding:8px 0;color:#888;">Satisfaction</td><td style="padding:8px 0;font-weight:600;">${esc(satLabel)}</td></tr>
      ${amelioration ? `<tr><td style="padding:8px 0;color:#888;vertical-align:top;">Amélioration</td><td style="padding:8px 0;">${esc(amelioration)}</td></tr>` : ''}
    `;

    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
      from:    `${cfg.fromName} <${cfg.fromEmail}>`,
      to:      [cfg.destEmail],
      subject: `⭐ Feedback ${typeLabel} — ${note}/5 — ${sender||'Anonyme'}`,
      html:    emailHtml({ icon:'⭐', color:'#F4B942', type:'Retour d\'expérience', sender: sender||'Anonyme', date: now(), filename: `Note ${note}/5 — ${satLabel}`, extra, note:'', appTitle:cfg.appTitle, footer:cfg.footerText }),
      text:    `Feedback\nDe : ${sender||'Anonyme'}\nType : ${typeLabel}\nNote : ${note}/5\nSatisfaction : ${satLabel}\nAmélioration : ${amelioration||'—'}`,
    });
    if (error) throw new Error(error.message);
    console.log(`⭐ Feedback [${data.id}] note=${note}`);
    res.json({ ok: true });
  } catch(e) { console.error(e); res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════
function emailHtml({ icon, color, type, sender, date, filename, extra, note, raw, link, appTitle, footer }) {
  let body = '';
  if (raw)  body = note;
  else if (note) body = `<div style="margin-top:16px;padding:12px 14px;background:#f8f9fa;border-left:3px solid ${color};border-radius:4px;font-size:14px;color:#555;">${esc(note)}</div>`;

  // Bouton lien cloud
  const linkBtn = link ? `
  <div style="margin-top:20px;">
    <a href="${link}" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,${color},${color}bb);color:#fff;font-weight:700;font-size:14px;border-radius:8px;text-decoration:none;">
      ☁️ Accéder au fichier
    </a>
    <p style="margin-top:10px;font-size:12px;color:#888;">Lien direct : <a href="${link}" style="color:${color};">${link}</a></p>
  </div>` : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background:#fdf6f0;font-family:'Segoe UI',Arial,sans-serif;">
<div style="max-width:600px;margin:28px auto;background:#fff;border-radius:18px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08);">
  <div style="background:linear-gradient(135deg,${color},${color}bb);padding:26px 32px;">
    <p style="margin:0 0 4px;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,.7);">${esc(appTitle)}</p>
    <h1 style="margin:0;font-size:20px;color:#fff;font-weight:700;">${icon} ${esc(type)}</h1>
  </div>
  <div style="padding:5px 32px 0;background:#fafaf8;border-bottom:1px solid #eee;display:flex;gap:20px;font-size:12px;color:#888;flex-wrap:wrap;">
    <span style="padding:10px 0;">👤 ${esc(sender)}</span>
    <span style="padding:10px 0;">📅 ${esc(date)}</span>
    <span style="padding:10px 0;">📝 ${esc(filename)}</span>
  </div>
  <div style="padding:22px 32px;">
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${extra}</table>
    ${body}${linkBtn}
  </div>
  <div style="padding:14px 32px;background:#fdf6f0;border-top:1px solid #f0e8e0;font-size:11px;color:#bbb;text-align:center;">${esc(footer)}</div>
</div></body></html>`;
}

function getMimeAudio(f) {
  const e = path.extname(f).toLowerCase();
  return { '.webm':'audio/webm', '.ogg':'audio/ogg', '.mp4':'audio/mp4', '.m4a':'audio/mp4' }[e] || 'audio/webm';
}

function getMimeVideo(f) {
  const e = path.extname(f).toLowerCase();
  return { '.webm':'video/webm', '.mp4':'video/mp4', '.ogg':'video/ogg', '.mov':'video/quicktime' }[e] || 'video/webm';
}

function now() { return new Date().toLocaleString('fr-FR'); }

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Start ─────────────────────────────────────────────────────────
app.listen(port, () => {
  const cfg = getConfig();
  console.log(`🌟 Témoigne de moi v2 → http://localhost:${port}`);
  console.log(`   DEST_EMAIL  : ${cfg.destEmail || '⚠️  non configuré → /admin'}`);
  console.log(`   Admin       : http://localhost:${port}/admin`);
  console.log(`   Résend key  : ${process.env.RESEND_API_KEY ? '✅ présente' : '⚠️  manquante'}`);
});

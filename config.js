/**
 * config.js — Source unique de vérité pour tous les paramètres
 * Priorité : config.json (admin) > .env (déploiement) > valeurs par défaut
 * Pour changer d'hébergeur : seul .env change, rien d'autre.
 */
const fs   = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'config.json');

function defaults() {
  return {
    // ── Email ──────────────────────────────────────────────────
    destEmail:      process.env.DEST_EMAIL       || '',
    fromEmail:      process.env.FROM_EMAIL       || 'onboarding@resend.dev',
    fromName:       process.env.FROM_NAME        || 'Témoigne de moi',

    // ── Application ────────────────────────────────────────────
    appTitle:       process.env.APP_TITLE        || 'Témoigne de moi',
    appSubtitle:    process.env.APP_SUBTITLE     || 'Votre voix, votre histoire',
    footerText:     process.env.FOOTER_TEXT      || 'Envoyé via Témoigne de moi',

    // ── Page d'accueil personnalisable ─────────────────────────
    badgeText:      process.env.BADGE_TEXT       || 'Votre voix compte',
    heroTitle:      process.env.HERO_TITLE       || 'Témoigne|de moi',
    logoDataUrl:    '',   // image base64 uploadée depuis l'admin

    // ── 4e carte (croix) ───────────────────────────────────────
    croixCardTitle: process.env.CROIX_TITLE      || 'Votre voix compte',
    croixCardTag:   process.env.CROIX_TAG        || 'Prière',
    croixCardDesc:  process.env.CROIX_DESC       || 'Partagez un témoignage de foi ou une intention de prière',
    croixCardUrl:   process.env.CROIX_URL        || '#',

    // ── TinyMCE ────────────────────────────────────────────────
    tinymceKey:     process.env.TINYMCE_KEY      || 'no-api-key',

    // ── Admin ──────────────────────────────────────────────────
    adminPassword:  process.env.ADMIN_PASSWORD   || 'admin123',

    // ── Audio ──────────────────────────────────────────────────
    audioPrefix:    process.env.AUDIO_PREFIX     || 'vocal',
    audioSizeMb:    parseInt(process.env.AUDIO_SIZE_MB  || '10'),

    // ── Vidéo ──────────────────────────────────────────────────
    videoSizeMb:    parseInt(process.env.VIDEO_SIZE_MB  || '25'),

    // ── Écrit ──────────────────────────────────────────────────
    ecritSizeMb:    parseInt(process.env.ECRIT_SIZE_MB  || '5'),

    // ── Stockage distant ───────────────────────────────────────
    // Type : 'none' | 'gdrive' | 'ftp' | 'webhook'
    storageType:    process.env.STORAGE_TYPE     || 'none',

    // Google Drive
    gdriveFolder:   process.env.GDRIVE_FOLDER_ID || '',
    gdriveJson:     process.env.GDRIVE_SERVICE_ACCOUNT_JSON || '',

    // FTP / SFTP
    ftpHost:        process.env.FTP_HOST         || '',
    ftpPort:        process.env.FTP_PORT         || '21',
    ftpUser:        process.env.FTP_USER         || '',
    ftpPassword:    process.env.FTP_PASSWORD      || '',
    ftpPath:        process.env.FTP_PATH         || '/uploads',
    ftpPublicUrl:   process.env.FTP_PUBLIC_URL   || '',

    // Webhook (POST multipart)
    webhookUrl:     process.env.WEBHOOK_URL      || '',
    webhookSecret:  process.env.WEBHOOK_SECRET   || '',
  };
}

function getConfig() {
  const d = defaults();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return { ...d, ...saved };
    }
  } catch(e) { console.warn('config.json illisible, valeurs par défaut.'); }
  return d;
}

function setConfig(updates) {
  const next = { ...getConfig(), ...updates };
  // Ne jamais stocker la clé Resend dans config.json (sécurité)
  delete next.resendKey;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { getConfig, setConfig };

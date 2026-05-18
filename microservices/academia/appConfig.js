const {
  jwtSecret,
  smtpUser,
  smtpPass,
  publicFrontendUrl,
} = require("./loadSecrets");

const DEPLOY = {
  PUBLIC_FRONTEND_URL: publicFrontendUrl(),
  PUBLIC_HOST: "192.168.100.25",
  PUBLIC_PORT: "5173",
};

function getPublicFrontendUrl() {
  if (DEPLOY.PUBLIC_FRONTEND_URL) {
    return DEPLOY.PUBLIC_FRONTEND_URL.replace(/\/$/, "");
  }
  return `http://${DEPLOY.PUBLIC_HOST}:${DEPLOY.PUBLIC_PORT}`;
}

module.exports = {
  JWT_SECRET: jwtSecret(),
  JWT_EXPIRES_IN: "24h",
  SMTP_USER: smtpUser(),
  SMTP_PASS: smtpPass(),
  NODE_ENV: "production",
  PORT: parseInt(process.env.PORT, 10) || 3001,

  WHATSAPP_DEBUG: false,
  // En Railway (Docker) los eventos 'message'/'message_create' de Puppeteer no se emiten
  // de forma confiable. Habilitamos el poll como mecanismo principal de recepción.
  WHATSAPP_UNREAD_POLL_ENABLED: true,
  WHATSAPP_GRACE_MS: 5 * 60 * 1000,
  WHATSAPP_UNREAD_POLL_INTERVAL_MS: 12000, // Chequear mensajes no leídos cada 12 segundos
  WHATSAPP_PROCESSED_TTL_MS: 10 * 60 * 1000,
  WHATSAPP_PROCESSED_MAX: 5000,
  WHATSAPP_CI_WINDOW_MS: 3 * 60 * 1000,
  WHATSAPP_CI_RATE_MAX: 5,
  WHATSAPP_CI_MAX_ATTEMPTS: 3,
  WHATSAPP_CI_LOCK_MS: 5 * 60 * 60 * 1000,
  WHATSAPP_AUTO_KILL_CHROME: true,
  GEMINI_EMBEDDINGS_TIMEOUT_MS: 12000,

  DEPLOY,
  getPublicFrontendUrl,
};

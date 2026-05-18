const fs = require("fs");
const path = require("path");

const PUPPETEER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--no-zygote",
  // REMOVIDO: '--single-process' causa que Chrome no emita eventos WebSocket de forma
  // confiable en Docker/Railway, lo que impide recibir mensajes de WhatsApp en tiempo real.
  "--disable-gpu",
  "--disable-web-security",
  "--disable-features=IsolateOrigins,site-per-process",
  // Flags adicionales para estabilidad en contenedores
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-ipc-flooding-protection",
  "--memory-pressure-off",
];

function archivoExiste(ruta) {
  if (!ruta) return false;
  try {
    return fs.existsSync(ruta);
  } catch {
    return false;
  }
}

function buscarNavegadorWindows() {
  const candidatos = [
    process.env.WHATSAPP_BROWSER_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.LOCALAPPDATA &&
      path.join(
        process.env.LOCALAPPDATA,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  ].filter(Boolean);

  for (const ruta of candidatos) {
    if (archivoExiste(ruta)) return ruta;
  }
  return null;
}

function buscarNavegadorLinux() {
  const candidatos = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.WHATSAPP_BROWSER_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
  ].filter(Boolean);

  for (const ruta of candidatos) {
    if (archivoExiste(ruta)) return ruta;
  }
  return null;
}

/**
 * whatsapp-web.js usa Puppeteer (motor Chromium).
 * En tu PC puede ser Chrome, Edge o Brave.
 * En Railway/Linux debe existir Chromium instalado en el servidor (Dockerfile).
 */
function obtenerConfigPuppeteerWhatsApp() {
  const esWindows = process.platform === "win32";
  const executablePath = esWindows
    ? buscarNavegadorWindows()
    : buscarNavegadorLinux();

  const config = {
    headless: true,
    args: PUPPETEER_ARGS,
    timeout: 90000,
  };

  if (executablePath) {
    config.executablePath = executablePath;
    console.log(`🌐 [WhatsApp] Navegador: ${executablePath}`);
  } else if (esWindows) {
    console.warn(
      "⚠️ [WhatsApp] No se encontró Chrome/Edge/Brave. Instala uno o define WHATSAPP_BROWSER_PATH en secrets.local.js",
    );
  } else {
    console.warn(
      "⚠️ [WhatsApp] Sin Chromium en Linux. Railway necesita el Dockerfile del proyecto (apt install chromium).",
    );
  }

  return config;
}

module.exports = {
  obtenerConfigPuppeteerWhatsApp,
  PUPPETEER_ARGS,
};

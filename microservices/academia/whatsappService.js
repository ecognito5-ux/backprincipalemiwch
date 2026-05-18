const {
  WHATSAPP_DEBUG: WHATSAPP_DEBUG_CFG,
  WHATSAPP_UNREAD_POLL_ENABLED: WHATSAPP_UNREAD_POLL_ENABLED_CFG,
  WHATSAPP_GRACE_MS: WHATSAPP_GRACE_MS_CFG,
  WHATSAPP_UNREAD_POLL_INTERVAL_MS: WHATSAPP_UNREAD_POLL_INTERVAL_MS_CFG,
  WHATSAPP_PROCESSED_TTL_MS: WHATSAPP_PROCESSED_TTL_MS_CFG,
  WHATSAPP_PROCESSED_MAX: WHATSAPP_PROCESSED_MAX_CFG,
  WHATSAPP_CI_WINDOW_MS: WHATSAPP_CI_WINDOW_MS_CFG,
  WHATSAPP_CI_RATE_MAX: WHATSAPP_CI_RATE_MAX_CFG,
  WHATSAPP_CI_MAX_ATTEMPTS: WHATSAPP_CI_MAX_ATTEMPTS_CFG,
  WHATSAPP_CI_LOCK_MS: WHATSAPP_CI_LOCK_MS_CFG,
  WHATSAPP_AUTO_KILL_CHROME: WHATSAPP_AUTO_KILL_CHROME_CFG,
  getPublicFrontendUrl,
} = require("./appConfig");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const QRGenerator = require("./qrGenerator");
const pool = require("./config");
const { ejecutarAgente } = require("./agenteInteligente");
const ConversacionManager = require("./conversacionManager");
const fs = require("fs");
const path = require("path");
const { obtenerConfigPuppeteerWhatsApp } = require("./whatsappPuppeteerConfig");

// Instancia del gestor de conversaciones para WhatsApp
const conversacionManager = new ConversacionManager(pool);

const WHATSAPP_DEBUG = !!WHATSAPP_DEBUG_CFG;
const infoLog = (...args) => console.log(...args);
const debugLog = (...args) => {
  if (WHATSAPP_DEBUG) console.log(...args);
};

// Carpeta donde se guardan comprobantes descargados desde WhatsApp (evidencia)
const MSM_COMPROBANTES_DIR = path.join(process.cwd(), "msmcomprobantes");
try {
  if (!fs.existsSync(MSM_COMPROBANTES_DIR)) {
    fs.mkdirSync(MSM_COMPROBANTES_DIR, { recursive: true });
  }
} catch (e) {
  // Si no se puede crear, no bloquear el servicio
}

class WhatsAppService {
  constructor() {
    this.client = null;
    this.isReady = false;
    this.qrCode = null;
    this.qrImage = null;
    this.phoneNumber = null;
    this.serverStartTime = Date.now(); // Timestamp de cuando se inició el servidor
    // Ventana de gracia para no “perder” mensajes durante la sincronización inicial.
    // Configurable con WHATSAPP_GRACE_MS (por defecto: 5 minutos).
    this.graceMs = Number(WHATSAPP_GRACE_MS_CFG);
    this.initializing = false;
    this._sendSeenPatched = false;
    this._downloadPatched = false;
    this._unreadPollDone = false;
    this._unreadPollInterval = null;
    // Tiempo real por eventos; poll solo como respaldo.
    this._unreadPollEnabled = WHATSAPP_UNREAD_POLL_ENABLED_CFG !== false;
    this._unreadPollIntervalMs = Math.max(
      10000,
      Number(WHATSAPP_UNREAD_POLL_INTERVAL_MS_CFG),
    );

    // Evitar respuestas duplicadas por polls/unread_count/message_create
    this._processedMsgIds = new Map(); // key -> timestamp(ms)
    this._processedMsgTtlMs = Number(WHATSAPP_PROCESSED_TTL_MS_CFG);
    this._processedMsgMax = Number(WHATSAPP_PROCESSED_MAX_CFG);

    // Seguridad CI (validación de identidad) + rate limit por comportamiento
    this._ciSecurity = {
      rateLimitMap: new Map(), // telefonoNormalizado => [timestampsMs]
      rateWindowMs: Number(WHATSAPP_CI_WINDOW_MS_CFG),
      rateMax: Number(WHATSAPP_CI_RATE_MAX_CFG),
      maxCiAttempts: Number(WHATSAPP_CI_MAX_ATTEMPTS_CFG),
      lockDurationMs: Number(WHATSAPP_CI_LOCK_MS_CFG),
    };
  }

  // Parchea WhatsApp Web para que no falle al intentar marcar como leído (sendSeen/markedUnread).
  // WhatsApp cambia internamente y a veces rompe whatsapp-web.js; este parche evita que el bot se quede sin responder.
  async parchearSendSeen() {
    if (!this.client || !this.client.pupPage) return false;
    if (this._sendSeenPatched) return true;

    const page = this.client.pupPage;

    try {
      // Verificar que la página no esté cerrada
      if (page.isClosed()) {
        console.warn("⚠️ Página cerrada, no se puede aplicar parche sendSeen");
        return false;
      }

      // Intentar varias veces porque WWebJS puede tardar en estar disponible
      for (let i = 0; i < 12; i++) {
        try {
          // Verificar nuevamente antes de cada intento
          if (page.isClosed()) return false;

          const patched = await Promise.race([
            page.evaluate(() => {
              if (
                !window.WWebJS ||
                typeof window.WWebJS.sendSeen !== "function"
              )
                return false;

              const original = window.WWebJS.sendSeen.bind(window.WWebJS);
              window.WWebJS.sendSeen = async (...args) => {
                try {
                  return await original(...args);
                } catch (e) {
                  return null;
                }
              };

              return true;
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Timeout")), 3000),
            ),
          ]);

          if (patched) {
            this._sendSeenPatched = true;
            console.log(
              "🩹 Parche sendSeen aplicado (evita error markedUnread)",
            );
            return true;
          }
        } catch (evalError) {
          // Si es error de contexto destruido, esperar y reintentar
          if (
            evalError.message.includes("destroyed") ||
            evalError.message.includes("context")
          ) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          // Otros errores, continuar con siguiente intento
        }

        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (error) {
      // No romper la inicialización si el parche falla
      console.warn(
        "⚠️ No se pudo aplicar parche sendSeen (no crítico):",
        error.message,
      );
    }

    return false;
  }

  // Parche para evitar errores de downloadMedia con addAnnotations (cambios en Web WhatsApp)
  async parchearDownloadMedia() {
    if (!this.client || !this.client.pupPage) return false;
    if (this._downloadPatched) return true;

    const page = this.client.pupPage;

    try {
      // Verificar que la página no esté cerrada
      if (page.isClosed()) {
        console.warn(
          "⚠️ Página cerrada, no se puede aplicar parche downloadMedia",
        );
        return false;
      }

      const patched = await Promise.race([
        page.evaluate(() => {
          try {
            // Stub mínimo para qpl que ahora espera addAnnotations
            const makeQpl = () => ({
              addAnnotations() {
                return this;
              },
              addDataPoint() {
                return this;
              },
              addDataPoints() {
                return this;
              },
              addPoint() {
                return this;
              },
              endSuccess() {
                return this;
              },
              endFailure() {
                return this;
              },
            });

            // Si WhatsApp espera window.qpl, darle un stub
            if (!window.qpl) {
              window.qpl = {
                inProgress: () => makeQpl(),
                start: () => makeQpl(),
              };
            }

            // Parchear DownloadManager para inyectar downloadQpl si falta
            if (
              window.Store &&
              window.Store.DownloadManager &&
              typeof window.Store.DownloadManager.downloadAndMaybeDecrypt ===
                "function"
            ) {
              const original =
                window.Store.DownloadManager.downloadAndMaybeDecrypt;
              window.Store.DownloadManager.downloadAndMaybeDecrypt = (opts) => {
                if (!opts.downloadQpl) {
                  opts.downloadQpl = {
                    inProgress: () => makeQpl(),
                    start: () => makeQpl(),
                  };
                }
                return original(opts);
              };
              return true;
            }
          } catch (e) {
            return false;
          }
          return false;
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 3000),
        ),
      ]);

      if (patched) {
        this._downloadPatched = true;
        console.log("🩹 Parche downloadMedia aplicado (stub addAnnotations)");
        return true;
      }
    } catch (error) {
      // No romper la inicialización si el parche falla
      if (
        error.message.includes("destroyed") ||
        error.message.includes("context")
      ) {
        console.warn(
          "⚠️ Contexto destruido al aplicar parche downloadMedia (no crítico)",
        );
      } else {
        console.warn(
          "⚠️ No se pudo aplicar parche downloadMedia (no crítico):",
          error.message,
        );
      }
    }

    return false;
  }

  async initialize() {
    // Evitar múltiples inicializaciones simultáneas
    if (this.initializing) {
      return;
    }

    if (this.client) {
      return;
    }

    this.initializing = true;

    try {
      // Resetear estado
      this.isReady = false;
      this.qrCode = null;
      this.qrImage = null;
      this.phoneNumber = null;
      this._unreadPollDone = false;
      if (this._unreadPollInterval) {
        clearInterval(this._unreadPollInterval);
        this._unreadPollInterval = null;
      }

      this.client = new Client({
        authStrategy: new LocalAuth({
          dataPath: path.join(process.cwd(), ".wwebjs_auth"),
        }),
        puppeteer: obtenerConfigPuppeteerWhatsApp(),
      });

      // Evento QR - se dispara cuando se genera un nuevo QR
      this.client.on("qr", async (qr) => {
        console.log("📱 QR generado correctamente");
        this.qrCode = qr;

        try {
          this.qrImage = await QRGenerator.generateQRImage(qr);
          console.log("✅ QR imagen generada correctamente");
        } catch (error) {
          console.error("❌ Error generando QR como imagen:", error);
        }
      });

      // Evento authenticated - se dispara cuando se escanea el QR
      this.client.on("authenticated", () => {
        console.log("✅ WhatsApp autenticado correctamente");
        this.qrCode = null;
        this.qrImage = null;

        // Verificar periódicamente si el cliente está listo después de autenticarse
        // El evento 'ready' a veces no se dispara, así que verificamos manualmente
        let intentos = 0;
        const maxIntentos = 40; // 40 intentos = 20 segundos

        const verificarListo = setInterval(async () => {
          intentos++;
          try {
            if (this.client) {
              // Intentar obtener el estado del cliente con timeout
              const state = await Promise.race([
                this.client.getState(),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error("Timeout")), 2000),
                ),
              ]).catch(() => null);

              // Si el estado es CONNECTED, marcar como listo (incluso si info no está disponible aún)
              if (state === "CONNECTED") {
                this.isReady = true;
                this.qrCode = null;
                this.qrImage = null;
                this.serverStartTime = Date.now();
                console.log(
                  `✅ Servidor listo a las ${new Date().toLocaleString("es-BO")} - Solo se responden mensajes que lleguen a partir de ahora`,
                );

                // Intentar obtener el número de teléfono inmediatamente
                try {
                  const info = await Promise.race([
                    this.client.info,
                    new Promise((_, reject) =>
                      setTimeout(() => reject(new Error("Timeout")), 3000),
                    ),
                  ]).catch(() => null);

                  if (info && info.wid) {
                    let numeroAutenticado = null;
                    if (info.wid.user) {
                      numeroAutenticado = info.wid.user;
                    } else if (info.wid._serialized) {
                      numeroAutenticado = info.wid._serialized.split("@")[0];
                    }

                    if (numeroAutenticado) {
                      const numeroNormalizado =
                        this.normalizarNumero(numeroAutenticado);
                      console.log(
                        `📱 Número autenticado después de escanear QR: ${numeroAutenticado} -> Normalizado: ${numeroNormalizado}`,
                      );
                      this.phoneNumber = numeroAutenticado;
                    }
                  }
                } catch (phoneError) {
                  console.warn(
                    `⚠️ No se pudo obtener número inmediatamente: ${phoneError.message}`,
                  );
                }

                // Intentar obtener el número de teléfono en segundo plano (no bloquear)
                this.obtenerNumeroTelefono().catch(() => {
                  // Ignorar errores, el número se obtendrá más tarde
                });

                // Aplicar parches en segundo plano (no críticos)
                setTimeout(() => {
                  this.parchearSendSeen().catch(() => {});
                  this.parchearDownloadMedia().catch(() => {});
                }, 3000); // Esperar 3 segundos para que la página esté completamente estable

                // Poll inicial + poll periódico cada 60s (mensajes en tiempo real que no emiten message/message_create)
                setTimeout(() => {
                  runUnreadPoll().catch(() => {});
                  startPeriodicUnreadPoll();
                }, 8000);

                clearInterval(verificarListo);
                return;
              }
            }
          } catch (error) {
            // Si es error de contexto destruido, esperar más tiempo antes de reintentar
            if (
              error.message &&
              (error.message.includes("destroyed") ||
                error.message.includes("context"))
            ) {
              // Esperar un poco más antes del siguiente intento
              await new Promise((r) => setTimeout(r, 1000));
            }
            // Otros errores: continuar verificando normalmente
          }

          // Si excedemos los intentos máximos, limpiar el intervalo
          if (intentos >= maxIntentos) {
            clearInterval(verificarListo);
            console.warn(
              "⚠️ Timeout verificando estado de WhatsApp (continuará en segundo plano)",
            );
          }
        }, 500);
      });

      // Evento ready - se dispara cuando el cliente está completamente listo
      this.client.on("ready", async () => {
        console.log("✅ WhatsApp está completamente listo (evento ready)");
        this.isReady = true;
        this.qrCode = null;
        this.qrImage = null;
        this.serverStartTime = Date.now();
        console.log(
          `✅ Servidor listo a las ${new Date().toLocaleString("es-BO")} - Solo se responden mensajes que lleguen a partir de ahora`,
        );

        // Obtener número de teléfono inmediatamente
        try {
          const info = await Promise.race([
            this.client.info,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Timeout")), 3000),
            ),
          ]).catch(() => null);

          if (info && info.wid) {
            let numeroAutenticado = null;
            if (info.wid.user) {
              numeroAutenticado = info.wid.user;
            } else if (info.wid._serialized) {
              numeroAutenticado = info.wid._serialized.split("@")[0];
            }

            if (numeroAutenticado) {
              const numeroNormalizado =
                this.normalizarNumero(numeroAutenticado);
              console.log(
                `📱 Número autenticado (evento ready): ${numeroAutenticado} -> Normalizado: ${numeroNormalizado}`,
              );
              this.phoneNumber = numeroAutenticado;
            } else {
              console.warn(`⚠️ No se pudo extraer número del evento ready`);
              console.log(`   Info wid:`, JSON.stringify(info.wid, null, 2));
            }
          }
        } catch (phoneError) {
          console.warn(
            `⚠️ Error obteniendo número en evento ready: ${phoneError.message}`,
          );
        }

        // Obtener número de teléfono en segundo plano (fallback)
        this.obtenerNumeroTelefono().catch(() => {
          // El número se intentará obtener más tarde
        });

        // Aplicar parches en segundo plano después de un delay (no críticos)
        setTimeout(() => {
          this.parchearSendSeen().catch(() => {});
          this.parchearDownloadMedia().catch(() => {});
        }, 3000); // Esperar 3 segundos para que la página esté completamente estable

        // Poll inicial + poll periódico cada 60s (mensajes en tiempo real que no emiten message/message_create)
        setTimeout(() => {
          runUnreadPoll().catch(() => {});
          startPeriodicUnreadPoll();
        }, 8000);
      });

      // Evento auth_failure
      this.client.on("auth_failure", (msg) => {
        console.error("❌ Error de autenticación:", msg);
        this.isReady = false;
        this.qrCode = null;
        this.qrImage = null;
        this.phoneNumber = null;
      });

      // Evento disconnected
      this.client.on("disconnected", (reason) => {
        console.warn("⚠️ Cliente WhatsApp desconectado:", reason);
        this.isReady = false;
        this.qrCode = null;
        this.qrImage = null;
        this.phoneNumber = null;
        if (this._unreadPollInterval) {
          clearInterval(this._unreadPollInterval);
          this._unreadPollInterval = null;
        }
      });

      // Evento loading_screen - se dispara cuando WhatsApp está cargando
      this.client.on("loading_screen", (percent, message) => {
        console.log(`⏳ Cargando WhatsApp: ${percent}% - ${message}`);
      });

      // Convierte _data.from / _data.author (string u objeto {user,_serialized}) a string para .split/.includes
      const toIdString = (val) => {
        if (val == null) return null;
        if (typeof val === "string") return val;
        if (typeof val === "object" && val !== null) {
          if (typeof val.user === "string") return val.user;
          if (typeof val._serialized === "string") return val._serialized;
        }
        return null;
      };

      const yaProcesado = (message, fromMsg) => {
        try {
          const now = Date.now();
          const ttl = this._processedMsgTtlMs || 0;
          const max = this._processedMsgMax || 2000;
          const map = this._processedMsgIds;

          // Limpieza incremental por TTL (Map mantiene orden de inserción)
          if (ttl > 0) {
            while (map.size > 0) {
              const first = map.entries().next().value;
              if (!first) break;
              const [, ts] = first;
              if (typeof ts === "number" && now - ts > ttl)
                map.delete(first[0]);
              else break;
            }
          }

          const idSerialized = message?.id?._serialized
            ? String(message.id._serialized)
            : null;
          const ts =
            message?.timestamp != null ? String(message.timestamp) : "";
          const body = String(message?.body || "").slice(0, 80);
          const key = idSerialized || `${String(fromMsg || "")}|${ts}|${body}`;

          if (map.has(key)) return true;
          map.set(key, now);

          // Limitar tamaño
          while (map.size > max) {
            const k0 = map.keys().next().value;
            if (k0 == null) break;
            map.delete(k0);
          }
          return false;
        } catch (_) {
          return false;
        }
      };

      const handlerMensaje = async (message) => {
        try {
          // Verificar que message existe y tiene propiedades básicas
          if (!message || !message.id) {
            console.error("❌ [WhatsApp] Mensaje inválido recibido");
            return;
          }
          const idStr =
            message.id._serialized || (message.id && String(message.id)) || "?";
          const bodyPreview = String(message.body || "").slice(0, 50);
          const fromMsg =
            typeof message.from === "string"
              ? message.from
              : toIdString(message.from) || "";
          // Log siempre visible para diagnosticar si llegan eventos y por qué se filtran
          console.log(
            `📩 [WhatsApp EVENT] from=${fromMsg || "?"} fromMe=${!!message.fromMe} type=${message.type || "?"} id=${idStr.slice(0, 40)} body="${bodyPreview}"`,
          );

          // Evitar reprocesar el mismo mensaje por polls/listeners múltiples
          if (yaProcesado(message, fromMsg)) {
            debugLog(
              `🔁 [WhatsApp] Ignorado (ya procesado) id=${idStr.slice(0, 30)}`,
            );
            return;
          }

          // Ignorar mensajes del propio bot (evita bucles)
          if (message.fromMe) {
            console.log("⏭️ [WhatsApp] Ignorado (fromMe)");
            return;
          }

          // Ignorar solo mensajes de estado y grupos
          if (
            fromMsg === "status@broadcast" ||
            (fromMsg && fromMsg.includes("@g.us"))
          ) {
            console.log(
              `⏭️ [WhatsApp] Ignorado (${fromMsg === "status@broadcast" ? "status" : "grupo"})`,
            );
            return;
          }
          if (message.type === "e2e_notification") {
            console.log("⏭️ [WhatsApp] Ignorado (e2e_notification)");
            return;
          }

          if (message.timestamp != null) {
            const mensajeTimestamp = message.timestamp * 1000;
            if (mensajeTimestamp < this.serverStartTime) {
              debugLog(
                `⏭️ [WhatsApp] Ignorado (anterior al inicio del servidor)`,
              );
              return;
            }
          }

          if (this._lastProcessedMsgId === message.id._serialized) {
            console.log(
              `🔁 [WhatsApp] Ignorado (duplicado) id=${idStr.slice(0, 30)}`,
            );
            return;
          }
          this._lastProcessedMsgId = message.id._serialized;

          infoLog(`📨 [WhatsApp] Mensaje recibido (${message.type || "N/A"})`);
          debugLog(
            `   from: ${message.from} body: ${String(message.body || "").substring(0, 80)}`,
          );
          debugLog(`✅ [WhatsApp] Mensaje válido from: ${message.from}`);

          // CRÍTICO: Intentar obtener el número real desde _data si está disponible
          let numeroDesdeData = null;
          if (message._data) {
            const fromStr = toIdString(message._data.from);
            if (fromStr) {
              const fromData = fromStr.split("@")[0];
              if (fromData && fromData.length <= 12) {
                numeroDesdeData = fromData;
                debugLog(
                  `📞 [WhatsApp] Número en _data.from: ${numeroDesdeData}`,
                );
              }
            }
            if (
              !numeroDesdeData &&
              typeof message._data.notifyName === "string"
            ) {
              const match = message._data.notifyName.match(/(\d{8,12})/);
              if (match) {
                numeroDesdeData = match[1];
                debugLog(
                  `📞 [WhatsApp] Número en _data.notifyName: ${numeroDesdeData}`,
                );
              }
            }
          }

          // CRÍTICO: Obtener el número real del remitente
          // WhatsApp Web.js ahora usa IDs internos (@lid) en lugar del número real
          // Necesitamos usar getContactLidAndPhone() para convertir @lid al número real
          let numeroRemitente = numeroDesdeData || null; // Usar número de _data si está disponible

          // Método 0: CRÍTICO - Resolver número real para IDs LID o c.us no resueltos
          if (!numeroRemitente && fromMsg && this.client) {
            try {
              const authorStr =
                toIdString(message._data?.author) || toIdString(message.author);
              if (authorStr && !authorStr.includes("lid")) {
                numeroRemitente = authorStr.split("@")[0];
                debugLog(
                  `✅ [WhatsApp] Número desde _data.author/author: ${numeroRemitente}`,
                );
              }

              // Si sigue sin número y es @lid, usar getContactLidAndPhone (requiere v1.34.5+)
              if (
                !numeroRemitente &&
                fromMsg.endsWith("@lid") &&
                typeof this.client.getContactLidAndPhone === "function"
              ) {
                const result = await this.client.getContactLidAndPhone([
                  fromMsg,
                ]);
                if (result && result.length > 0 && result[0].pn) {
                  const pn = result[0].pn;
                  const numeroReal =
                    typeof pn === "string"
                      ? pn.split("@")[0]
                      : toIdString(pn)?.split("@")[0];
                  if (numeroReal && numeroReal.length <= 15) {
                    numeroRemitente = numeroReal;
                    debugLog(
                      `✅ [WhatsApp] Número real (getContactLidAndPhone): ${numeroRemitente}`,
                    );
                  }
                }
              }

              // Fallback al Store de Puppeteer si todo lo anterior falla
              if (!numeroRemitente && this.client.pupPage) {
                const chatId = fromMsg;
                const resultStore = await this.client.pupPage.evaluate(
                  (cid) => {
                    try {
                      const chat = window.Store.Chat.get(cid);
                      if (chat && chat.contact) {
                        return chat.contact.id.user || chat.contact.number;
                      }
                      return null;
                    } catch (e) {
                      return null;
                    }
                  },
                  chatId,
                );
                if (resultStore && resultStore.length <= 15) {
                  numeroRemitente = resultStore;
                  debugLog(
                    `✅ [WhatsApp] Número desde Store(Puppeteer): ${numeroRemitente}`,
                  );
                }
              }
            } catch (lidError) {
              debugLog(
                `⚠️ [WhatsApp] Error resolviendo LID: ${lidError.message}`,
              );
            }
          }

          // Método 1: Intentar obtener desde el chat (más confiable)
          try {
            const chat = await message.getChat();
            if (chat) {
              debugLog(
                `🔍 [WhatsApp] Chat obtenido (isGroup=${!!chat.isGroup})`,
              );

              // Si no es grupo, intentar obtener el número del contacto
              if (!chat.isGroup) {
                // CRÍTICO: Intentar desde contactId primero
                if (chat.contactId) {
                  let contactId = null;
                  if (typeof chat.contactId === "object") {
                    if (chat.contactId.user) {
                      contactId = chat.contactId.user;
                    } else if (chat.contactId._serialized) {
                      contactId = chat.contactId._serialized.split("@")[0];
                    }
                  } else if (typeof chat.contactId === "string") {
                    contactId = chat.contactId.split("@")[0];
                  }

                  if (contactId && contactId.length <= 12) {
                    numeroRemitente = contactId;
                    debugLog(
                      `✅ [WhatsApp] Número desde chat.contactId: ${numeroRemitente}`,
                    );
                  }
                }

                // Intentar desde el ID del chat (si no es un ID largo)
                if (!numeroRemitente && chat.id) {
                  let chatIdUser = null;
                  if (chat.id.user && chat.id.user.length <= 12) {
                    chatIdUser = chat.id.user;
                  } else if (chat.id._serialized) {
                    const serialized = chat.id._serialized.split("@")[0];
                    if (serialized.length <= 12) {
                      chatIdUser = serialized;
                    }
                  } else if (typeof chat.id === "string") {
                    const idStr = chat.id.split("@")[0];
                    if (idStr.length <= 12) {
                      chatIdUser = idStr;
                    }
                  }

                  if (chatIdUser) {
                    numeroRemitente = chatIdUser;
                    debugLog(
                      `✅ [WhatsApp] Número desde chat.id: ${numeroRemitente}`,
                    );
                  }
                }

                // Intentar desde el nombre del chat (puede contener el número)
                if (!numeroRemitente && chat.name) {
                  const match = chat.name.match(/(\d{8,12})/);
                  if (match && match[1].length <= 12) {
                    numeroRemitente = match[1];
                    debugLog(
                      `✅ [WhatsApp] Número desde chat.name: ${numeroRemitente}`,
                    );
                  }
                }
              }
            }
          } catch (chatError) {
            debugLog(
              `⚠️ [WhatsApp] Error obteniendo chat: ${chatError.message}`,
            );
          }

          // Método 2: Intentar obtener usando Puppeteer directamente desde el Store
          // CRÍTICO: Buscar el número real usando el ID interno como referencia
          // Necesitamos buscar en todos los chats para encontrar el que tiene el ID interno y extraer su número real
          if (!numeroRemitente && this.client && this.client.pupPage) {
            try {
              const chatIdFromMessage = fromMsg.split("@")[0];
              const fullFrom = fromMsg;
              debugLog(
                `🔍 [WhatsApp] Resolviendo número via Store (Puppeteer) chatId=${chatIdFromMessage}`,
              );

              const numeroReal = await this.client.pupPage.evaluate(
                (chatId, fullFromId) => {
                  try {
                    if (window.Store && window.Store.Chat) {
                      // Buscar el chat usando el ID interno completo o parcial
                      let chat = null;

                      // CRÍTICO: Buscar en todos los chats por el ID interno
                      if (window.Store.Chat.models) {
                        for (const c of window.Store.Chat.models) {
                          if (c.id) {
                            // Verificar si el ID interno coincide (puede estar en _serialized o en user)
                            const idSerialized = c.id._serialized || "";
                            const idUser = c.id.user || "";

                            // Buscar coincidencia con el ID completo o parcial
                            if (
                              idSerialized.includes(chatId) ||
                              idSerialized.includes(fullFromId) ||
                              idUser === chatId ||
                              idUser.includes(chatId)
                            ) {
                              chat = c;
                              console.log("Chat encontrado por ID interno:", {
                                idSerialized: idSerialized,
                                idUser: idUser,
                                name: c.name || "N/A",
                              });
                              break;
                            }
                          }
                        }
                      }

                      // Método alternativo: Buscar usando get o find con el ID completo
                      if (!chat && window.Store.Chat.get) {
                        try {
                          chat = window.Store.Chat.get(fullFromId);
                          if (!chat) chat = window.Store.Chat.get(chatId);
                        } catch (e) {}
                      }
                      if (!chat && window.Store.Chat.find) {
                        try {
                          chat = window.Store.Chat.find(fullFromId);
                          if (!chat) chat = window.Store.Chat.find(chatId);
                        } catch (e) {}
                      }

                      if (chat) {
                        console.log("Chat encontrado en Store:", {
                          id: chat.id
                            ? chat.id._serialized ||
                              chat.id.user ||
                              JSON.stringify(chat.id)
                            : "N/A",
                          name: chat.name || "N/A",
                          hasContact: !!chat.contact,
                          contactId: chat.contactId
                            ? typeof chat.contactId === "object"
                              ? JSON.stringify(chat.contactId)
                              : chat.contactId
                            : "N/A",
                        });

                        // CRÍTICO: Intentar obtener el número del contacto
                        if (chat.contact) {
                          const contact = chat.contact;
                          // El contacto puede tener el número en diferentes lugares
                          if (
                            contact.id &&
                            contact.id.user &&
                            contact.id.user.length <= 12 &&
                            !contact.id.user.startsWith("1")
                          ) {
                            return contact.id.user;
                          }
                          if (contact.number && contact.number.length <= 12) {
                            return contact.number;
                          }
                          // Intentar desde contact._serialized
                          if (contact._serialized) {
                            const contactNum =
                              contact._serialized.split("@")[0];
                            if (
                              contactNum.length <= 12 &&
                              !contactNum.startsWith("1")
                            ) {
                              return contactNum;
                            }
                          }
                        }

                        // Intentar desde contactId del chat
                        if (chat.contactId) {
                          let contactId = null;
                          if (typeof chat.contactId === "object") {
                            if (
                              chat.contactId.user &&
                              chat.contactId.user.length <= 12 &&
                              !chat.contactId.user.startsWith("1")
                            ) {
                              contactId = chat.contactId.user;
                            } else if (chat.contactId._serialized) {
                              contactId =
                                chat.contactId._serialized.split("@")[0];
                              if (
                                contactId.length > 12 ||
                                contactId.startsWith("1")
                              )
                                contactId = null;
                            }
                          } else if (typeof chat.contactId === "string") {
                            contactId = chat.contactId.split("@")[0];
                            if (
                              contactId.length > 12 ||
                              contactId.startsWith("1")
                            )
                              contactId = null;
                          }
                          if (contactId) {
                            return contactId;
                          }
                        }

                        // Intentar desde el ID del chat (solo si parece un número real, no un ID largo)
                        if (chat.id) {
                          if (
                            chat.id.user &&
                            chat.id.user.length <= 12 &&
                            !chat.id.user.startsWith("1")
                          ) {
                            // Números bolivianos no empiezan con 1, IDs internos sí
                            return chat.id.user;
                          }
                          if (chat.id._serialized) {
                            const idNum = chat.id._serialized.split("@")[0];
                            if (idNum.length <= 12 && !idNum.startsWith("1")) {
                              return idNum;
                            }
                          }
                        }

                        // Intentar desde el título formateado
                        if (chat.formattedTitle) {
                          const match = chat.formattedTitle.match(/(\d{8,12})/);
                          if (
                            match &&
                            match[1].length <= 12 &&
                            !match[1].startsWith("1")
                          ) {
                            return match[1];
                          }
                        }

                        // Intentar desde el nombre
                        if (chat.name) {
                          const match = chat.name.match(/(\d{8,12})/);
                          if (
                            match &&
                            match[1].length <= 12 &&
                            !match[1].startsWith("1")
                          ) {
                            return match[1];
                          }
                        }
                      } else {
                        console.log(
                          "No se encontró chat en Store con ID:",
                          chatId,
                          "o",
                          fullFromId,
                        );
                        // Intentar listar algunos chats para debug
                        if (
                          window.Store.Chat.models &&
                          window.Store.Chat.models.length > 0
                        ) {
                          console.log(
                            "Primeros 5 chats disponibles:",
                            window.Store.Chat.models.slice(0, 5).map((c) => ({
                              id: c.id ? c.id._serialized || c.id.user : "N/A",
                              name: c.name || "N/A",
                            })),
                          );
                        }
                      }
                    }
                    return null;
                  } catch (e) {
                    console.error("Error en evaluación Puppeteer:", e);
                    return null;
                  }
                },
                chatIdFromMessage,
                fullFrom,
              );

              if (numeroReal && numeroReal.length <= 12) {
                numeroRemitente = numeroReal;
                debugLog(
                  `✅ [WhatsApp] Número via Store(Puppeteer): ${numeroRemitente}`,
                );
              } else {
                debugLog(
                  `⚠️ [WhatsApp] Store(Puppeteer) no devolvió número (res=${numeroReal})`,
                );
              }
            } catch (puppeteerError) {
              debugLog(
                `⚠️ [WhatsApp] Error con Puppeteer: ${puppeteerError.message}`,
              );
            }
          }

          // Método 3: Usar message.from o message.author como último recurso
          if (!numeroRemitente) {
            const authorFallback = toIdString(message.author);
            if (authorFallback) {
              numeroRemitente = authorFallback.split("@")[0];
              debugLog(`📞 [WhatsApp] Fallback author: ${numeroRemitente}`);
            } else if (fromMsg) {
              numeroRemitente = fromMsg.split("@")[0];
              debugLog(`📞 [WhatsApp] Fallback from: ${numeroRemitente}`);
            }
          }

          // Si el número sigue siendo muy largo, es un ID interno
          if (numeroRemitente && numeroRemitente.length > 12) {
            debugLog(
              `❌ [WhatsApp] No se pudo resolver número real (ID interno): ${numeroRemitente}`,
            );
          }

          debugLog(
            `📞 [WhatsApp] Remitente final: ${numeroRemitente} (len=${numeroRemitente?.length || 0})`,
          );

          const numeroNormalizado = this.normalizarNumero(numeroRemitente);
          debugLog(`📞 [WhatsApp] Normalizado: ${numeroNormalizado}`);

          // Buscar información del remitente en la base de datos
          const infoRemitente = await this.buscarRemitenteEnBD(
            numeroNormalizado,
            pool,
          );
          debugLog(
            `🔎 [WhatsApp] Remitente en BD: ${infoRemitente ? "sí" : "no"}`,
          );

          let textoMensaje = "";

          // Manejar diferentes tipos de mensajes
          if (message.type === "chat") {
            textoMensaje = message.body?.trim() || "";
            debugLog(
              `💬 [WhatsApp] Texto: "${textoMensaje.substring(0, 80)}${textoMensaje.length > 80 ? "..." : ""}"`,
            );
          } else if (message.type === "ptt" || message.type === "audio") {
            await this.enviarMensajeSeguro(
              message,
              "⚠️ No procesamos mensajes de voz. Por favor, envíe su consulta por texto.",
            );
            return;
          } else if (message.hasMedia) {
            // Ya no procesamos comprobantes directamente desde WhatsApp.
            // Redirigimos siempre al formulario público de envío de comprobantes.
            const enlace = `${getPublicFrontendUrl()}/envio-comprobantes`;

            await this.enviarMensajeSeguro(
              message,
              "⚠️ Para procesar comprobantes ahora usamos un formulario web.\n\n" +
                "Por favor cargue su comprobante en el siguiente enlace:\n\n" +
                `${enlace}\n\n` +
                "Complete los campos con sus datos correctos (especialmente su número de WhatsApp y CI).",
            );
            return;
          }

          if (!textoMensaje || textoMensaje.length === 0) {
            console.log("⚠️ Mensaje vacío, ignorando...");
            return;
          }

          debugLog(
            `📝 [WhatsApp] Texto a procesar: "${textoMensaje.substring(0, 120)}${textoMensaje.length > 120 ? "..." : ""}"`,
          );

          // Detección de mensajes sobre envío de comprobantes para Caja
          const textoLower = textoMensaje.toLowerCase().trim();
          const esMensajeComprobante =
            textoLower.includes("comprobante") ||
            textoLower.includes("recibo") ||
            textoLower.includes("transferencia") ||
            (textoLower.includes("pago") &&
              (textoLower.includes("hijo") || textoLower.includes("hija")));

          if (esMensajeComprobante && !message.hasMedia) {
            const enlace = `${getPublicFrontendUrl()}/envio-comprobantes`;

            await this.enviarMensajeSeguro(
              message,
              "✅ Entendí que quiere enviar un *comprobante de pago*.\n\n" +
                "Por favor cargue su comprobante en el siguiente enlace:\n\n" +
                `${enlace}\n\n` +
                "Complete los campos con sus datos correctos (especialmente su número de WhatsApp y CI).\n" +
                "Al enviarlo, la cajera lo revisará en el panel de Caja y en breve le confirmaremos su pago.",
            );
            return;
          }

          // Mensaje de bienvenida - Solo si es un saludo simple sin pregunta adicional

          // Palabras que indican que hay una pregunta/consulta después del saludo
          const palabrasConsulta = [
            "quiero",
            "necesito",
            "deseo",
            "cuánto",
            "cuanto",
            "cuál",
            "cual",
            "qué",
            "que",
            "cuánta",
            "cuanta",
            "cuántos",
            "cuantos",
            "cuántas",
            "cuantas",
            "pagar",
            "debo",
            "tengo",
            "saber",
            "información",
            "consultar",
            "preguntar",
            "mensualidad",
            "cuota",
            "deuda",
            "pendiente",
            "?",
            "¿",
          ];

          // Verificar si tiene consulta (más estricto: debe estar después de "hola")
          const tieneConsulta = palabrasConsulta.some((palabra) => {
            const indicePalabra = textoLower.indexOf(palabra);
            const indiceHola = textoLower.indexOf("hola");
            // La palabra de consulta debe estar después de "hola" o el mensaje debe tener más de 10 caracteres
            return (
              indicePalabra !== -1 &&
              (indicePalabra > indiceHola || textoLower.length > 10)
            );
          });

          // Es saludo simple solo si:
          // 1. Es exactamente un saludo (sin nada más)
          // 2. O empieza con "hola" pero NO tiene consulta Y es muy corto (menos de 10 caracteres)
          const esSaludoSimple =
            textoLower === "hola" ||
            textoLower === "hi" ||
            textoLower === "buenos días" ||
            textoLower === "buenas tardes" ||
            textoLower === "buenas noches" ||
            textoLower === "buen día" ||
            textoLower === "hola!" ||
            textoLower === "hola 👋" ||
            (textoLower.startsWith("hola") &&
              textoLower.length <= 10 &&
              !tieneConsulta);

          if (esSaludoSimple) {
            let saludo = "¡Hola! 👋";

            // Personalizar saludo si se encontró información del remitente
            if (infoRemitente) {
              if (infoRemitente.nombre_padre) {
                saludo = `¡Hola Sr. ${infoRemitente.nombre_padre}! 👋`;
              } else if (infoRemitente.nombre_madre) {
                saludo = `¡Hola Sra. ${infoRemitente.nombre_madre}! 👋`;
              } else if (infoRemitente.nombre_autorizado) {
                saludo = `¡Hola ${infoRemitente.nombre_autorizado}! 👋`;
              }
            }

            const respuestaSaludo = `${saludo} ¿En qué le puedo ayudar? ¿Cuál es su consulta?`;

            // Guardar sesión y mensajes para saludos también
            try {
              const contextoSesion = {
                telefono: numeroNormalizado,
                nombre_padre: infoRemitente?.nombre_padre || null,
                nombre_madre: infoRemitente?.nombre_madre || null,
                estudiante_id: infoRemitente?.estudiante_id || null,
              };
              const sesionId = await conversacionManager.obtenerOCrearSesion(
                null,
                "whatsapp",
                numeroNormalizado,
                contextoSesion,
              );
              infoLog(
                `📝 [WhatsApp] Sesión saludo: ${sesionId?.substring(0, 16)}...`,
              );

              await conversacionManager.agregarMensaje(
                sesionId,
                "usuario",
                textoMensaje,
                null,
                "saludo",
                { telefono: numeroNormalizado },
              );
              await conversacionManager.agregarMensaje(
                sesionId,
                "asistente",
                respuestaSaludo,
                "saludo_automatico",
                "saludo",
                {},
              );
            } catch (sesionError) {
              console.warn(
                "⚠️ No se pudo guardar sesión de saludo:",
                sesionError.message,
              );
            }

            await this.enviarMensajeSeguro(message, respuestaSaludo);
            return;
          }

          // Si contiene "hola" pero también tiene una pregunta, agregar saludo personalizado al inicio de la respuesta
          let saludoInicial = "";
          if (textoLower.includes("hola") && infoRemitente) {
            if (infoRemitente.nombre_padre) {
              saludoInicial = `¡Hola Sr. ${infoRemitente.nombre_padre}! 👋\n\n`;
            } else if (infoRemitente.nombre_madre) {
              saludoInicial = `¡Hola Sra. ${infoRemitente.nombre_madre}! 👋\n\n`;
            } else if (infoRemitente.nombre_autorizado) {
              saludoInicial = `¡Hola ${infoRemitente.nombre_autorizado}! 👋\n\n`;
            }
          }

          // Ignorar comandos del sistema
          if (textoMensaje.startsWith("/")) {
            return;
          }

          infoLog(
            `📱 [WhatsApp] Remitente ${numeroNormalizado || "desconocido"}: ${textoMensaje.substring(0, 60)}${textoMensaje.length > 60 ? "..." : ""}`,
          );

          // Registrar consulta para evitar recordatorios inmediatos después de consultas
          try {
            const RecordatoriosProactivosService = require("./recordatoriosProactivosService");
            const recordatoriosService = new RecordatoriosProactivosService();
            recordatoriosService.registrarConsulta(numeroNormalizado);
          } catch (error) {
            // No fallar si no se puede registrar la consulta
            console.warn(
              "⚠️ No se pudo registrar consulta para recordatorios:",
              error.message,
            );
          }

          // Procesar con agente inteligente (pasar información del remitente si está disponible)
          try {
            infoLog(`🤖 [Agente] Procesando mensaje`);

            // Crear o recuperar sesión de conversación para WhatsApp
            let sesionId = null;
            try {
              const contextoSesion = {
                telefono: numeroNormalizado,
                nombre_padre: infoRemitente?.nombre_padre || null,
                nombre_madre: infoRemitente?.nombre_madre || null,
                estudiante_id: infoRemitente?.estudiante_id || null,
              };
              sesionId = await conversacionManager.obtenerOCrearSesion(
                null, // usuario_id (no aplica para WhatsApp)
                "whatsapp",
                numeroNormalizado, // identificador externo = número de teléfono
                contextoSesion,
              );
              debugLog(
                `📝 [WhatsApp] Sesión: ${sesionId?.substring(0, 16)}...`,
              );
            } catch (sesionError) {
              console.warn(
                "⚠️ No se pudo crear/guardar sesión:",
                sesionError.message,
              );
            }

            // ===== Seguridad CI / rate limit antes de llamar al agente =====
            // Objetivo: si hay comportamiento sospechoso, pedir CI y NO llamar a `ejecutarAgente`
            // hasta validar identidad.
            if (sesionId) {
              try {
                const infoSesion =
                  await conversacionManager.obtenerInfoSesion(sesionId);
                const contextoSesion = infoSesion?.contexto || {};

                const ciRequerida = contextoSesion?.ci_requerida === true;
                const ciVerificada = contextoSesion?.ci_verificada === true;
                const ciBloqueadaUntil = contextoSesion?.ci_bloqueada_hasta
                  ? new Date(contextoSesion.ci_bloqueada_hasta).getTime()
                  : null;

                // Si está bloqueado, no respondemos con información del agente.
                if (
                  ciBloqueadaUntil &&
                  Number.isFinite(ciBloqueadaUntil) &&
                  Date.now() < ciBloqueadaUntil
                ) {
                  const minutosRestantes = Math.ceil(
                    (ciBloqueadaUntil - Date.now()) / (60 * 1000),
                  );
                  const respuesta = `Por motivos de seguridad, tu conversación se encuentra temporalmente bloqueada. Te responderemos nuevamente en aproximadamente ${minutosRestantes} minuto(s).`;

                  await conversacionManager.agregarMensaje(
                    sesionId,
                    "asistente",
                    respuesta,
                    "seguridad_ci",
                    "seguridad_ci",
                    { bloqueado: true, minutos_restantes: minutosRestantes },
                  );
                  await this.enviarMensajeSeguro(message, respuesta);
                  return;
                }

                const esNumero = String(textoMensaje || "").trim();

                // 1) Si el sistema ya pidió CI, interpretar el mensaje como CI
                if (ciRequerida) {
                  const ciInput = esNumero.replace(/\D/g, "").trim();
                  const intentosPrevios = Number(
                    contextoSesion?.ci_intentos || 0,
                  );
                  const intentosActuales = intentosPrevios + 1;

                  // Guardar mensaje del usuario como intento de CI
                  await conversacionManager.agregarMensaje(
                    sesionId,
                    "usuario",
                    textoMensaje,
                    null,
                    "ci_verificacion",
                    {
                      telefono: numeroNormalizado,
                      seguridad: "ci_verificacion",
                      ci_requerida: true,
                      ci_intento: intentosActuales,
                    },
                  );

                  let ciValida = false;
                  if (infoRemitente?.id_estudiante && ciInput.length >= 5) {
                    const [rows] = await pool.query(
                      `SELECT ci_padre, ci_madre
                       FROM estudiantes
                       WHERE id = ? AND estado_id = 1
                       LIMIT 1`,
                      [infoRemitente.id_estudiante],
                    );

                    if (rows && rows.length > 0) {
                      const ciPadre =
                        rows[0].ci_padre != null
                          ? String(rows[0].ci_padre).replace(/\D/g, "")
                          : "";
                      const ciMadre =
                        rows[0].ci_madre != null
                          ? String(rows[0].ci_madre).replace(/\D/g, "")
                          : "";
                      ciValida = ciInput === ciPadre || ciInput === ciMadre;
                    }
                  }

                  if (ciValida) {
                    await conversacionManager.actualizarContextoSesion(
                      sesionId,
                      {
                        ci_verificada: true,
                        ci_requerida: false,
                        ci_bloqueada: false,
                        ci_bloqueada_hasta: null,
                        ci_intentos: 0,
                        ci_verificada_en: new Date().toISOString(),
                      },
                    );

                    const respuesta =
                      "CI verificada. Por favor escribe tu pregunta nuevamente.";

                    await conversacionManager.agregarMensaje(
                      sesionId,
                      "asistente",
                      respuesta,
                      "seguridad_ci",
                      "seguridad_ci",
                      { validado: true },
                    );

                    await this.enviarMensajeSeguro(message, respuesta);
                    return;
                  } else {
                    if (intentosActuales >= this._ciSecurity.maxCiAttempts) {
                      await conversacionManager.actualizarContextoSesion(
                        sesionId,
                        {
                          ci_verificada: false,
                          ci_requerida: false,
                          ci_intentos: intentosActuales,
                          ci_bloqueada: true,
                          ci_bloqueada_hasta: new Date(
                            Date.now() + this._ciSecurity.lockDurationMs,
                          ).toISOString(),
                        },
                      );

                      const bloqueadoHasta = new Date(
                        Date.now() + this._ciSecurity.lockDurationMs,
                      );
                      const horasRestantes = Math.ceil(
                        (bloqueadoHasta.getTime() - Date.now()) /
                          (60 * 60 * 1000),
                      );
                      const respuesta = `Por motivos de seguridad, no pudimos verificar tu identidad. Te responderemos nuevamente en aproximadamente ${horasRestantes} hora(s). Por favor no envíes más consultas hasta ese momento.`;

                      await conversacionManager.agregarMensaje(
                        sesionId,
                        "asistente",
                        respuesta,
                        "seguridad_ci",
                        "seguridad_ci",
                        {
                          validado: false,
                          intentos: intentosActuales,
                          bloqueada: true,
                          horas_restantes: horasRestantes,
                        },
                      );

                      await this.enviarMensajeSeguro(message, respuesta);
                      return;
                    }

                    // CI incorrecta, mantener ci_requerida y aumentar intentos
                    await conversacionManager.actualizarContextoSesion(
                      sesionId,
                      {
                        ci_intentos: intentosActuales,
                      },
                    );

                    const respuesta = `CI no verificada. Por favor envía tu CI nuevamente. Intento ${intentosActuales}/${this._ciSecurity.maxCiAttempts}.`;

                    await conversacionManager.agregarMensaje(
                      sesionId,
                      "asistente",
                      respuesta,
                      "seguridad_ci",
                      "seguridad_ci",
                      { validado: false, intentos: intentosActuales },
                    );

                    await this.enviarMensajeSeguro(message, respuesta);
                    return;
                  }
                }

                // 2) Si no está verificado, aplicar rate limit para detectar comportamiento sospechoso
                if (!ciVerificada) {
                  const ahoraMs = Date.now();
                  const telefonoKey = numeroNormalizado;

                  // Solo contamos si la consulta viene de un remitente identificado (podremos validar CI)
                  // Si no hay infoRemitente, no bloqueamos por rate-limit y dejamos que el agente responda con restricciones ya existentes.
                  if (infoRemitente?.id_estudiante) {
                    const timestampsPrevios =
                      this._ciSecurity.rateLimitMap.get(telefonoKey) || [];
                    const timestamps = timestampsPrevios.filter(
                      (ts) => ahoraMs - ts <= this._ciSecurity.rateWindowMs,
                    );
                    timestamps.push(ahoraMs);
                    this._ciSecurity.rateLimitMap.set(telefonoKey, timestamps);

                    const exceso = timestamps.length > this._ciSecurity.rateMax;
                    if (exceso) {
                      await conversacionManager.actualizarContextoSesion(
                        sesionId,
                        {
                          ci_requerida: true,
                          ci_verificada: false,
                          ci_intentos: 0,
                        },
                      );

                      // Guardar mensaje del usuario como parte del flujo de verificación
                      await conversacionManager.agregarMensaje(
                        sesionId,
                        "usuario",
                        textoMensaje,
                        null,
                        "ci_requerida",
                        {
                          telefono: numeroNormalizado,
                          seguridad: "ci_requerida",
                          motivo: "rate_limit",
                          conteo_ventana: timestamps.length,
                        },
                      );

                      const respuesta =
                        "Para continuar, por favor envíame tu CI (solo números).";

                      await conversacionManager.agregarMensaje(
                        sesionId,
                        "asistente",
                        respuesta,
                        "seguridad_ci",
                        "seguridad_ci",
                        { rate_limit: true, conteo_ventana: timestamps.length },
                      );

                      await this.enviarMensajeSeguro(message, respuesta);
                      return;
                    }
                  }
                }

                // Si pasamos seguridad, guardamos el mensaje del usuario normal
                await conversacionManager.agregarMensaje(
                  sesionId,
                  "usuario",
                  textoMensaje,
                  null,
                  null,
                  { telefono: numeroNormalizado },
                );
              } catch (seguridadError) {
                // Si falla la lógica de seguridad, no bloqueamos el servicio:
                console.warn(
                  "⚠️ Error en seguridad CI/rate-limit:",
                  seguridadError.message,
                );
                // Guardar mensaje del usuario normal si aún no se guardó
                try {
                  await conversacionManager.agregarMensaje(
                    sesionId,
                    "usuario",
                    textoMensaje,
                    null,
                    null,
                    { telefono: numeroNormalizado },
                  );
                } catch (_) {}
              }
            }

            // ===== Llamada al agente (solo si NO retornamos antes) =====
            // Recuperar historial para mantener continuidad conversacional (clave para respuestas tipo "nuevo"/"regular")
            let historialConversacion = [];
            if (sesionId) {
              try {
                historialConversacion =
                  await conversacionManager.obtenerHistorial(sesionId, 10);
              } catch (histError) {
                historialConversacion = [];
              }
            }

            const resultado = await ejecutarAgente(
              textoMensaje,
              pool,
              null,
              infoRemitente,
              historialConversacion,
              null,
            );

            if (!resultado || !resultado.respuesta) {
              throw new Error("El agente no devolvió una respuesta válida");
            }

            let respuesta = resultado.respuesta
              .replace(/\*\*(.*?)\*\*/g, "*$1*")
              .replace(/\n{3,}/g, "\n\n")
              .trim();

            // Agregar saludo personalizado al inicio si hay uno y la respuesta no lo incluye
            if (saludoInicial && !respuesta.toLowerCase().includes("hola")) {
              respuesta = saludoInicial + respuesta;
            }

            // Diagnóstico: ver exactamente qué se enviará (evita "parece que envió" sin contenido).
            try {
              const previewStart = respuesta.slice(0, 600);
              const previewEnd =
                respuesta.length > 600 ? respuesta.slice(-350) : "";
              console.log(
                `🧾 [WhatsApp] Respuesta final del agente: ${respuesta.length} chars`,
              );
              console.log(`🧾 [WhatsApp] Preview inicio:\n${previewStart}`);
              if (previewEnd)
                console.log(`🧾 [WhatsApp] Preview final:\n${previewEnd}`);
            } catch (_) {}

            // Guardar respuesta completa para sesión (sin truncar)
            const respuestaParaGuardar = respuesta;

            // Para WhatsApp: si supera ~3800 chars, dividir en varios mensajes (límite ~4096)
            const LIMITE_WHATSAPP = 3800;
            const partes = [];
            if (respuesta.length <= LIMITE_WHATSAPP) {
              partes.push(respuesta);
            } else {
              // Dividir por párrafos cuando sea posible para mantener legibilidad
              const parrafos = respuesta.split(/\n\n+/);
              let parteActual = "";
              for (const p of parrafos) {
                if (parteActual.length + p.length + 2 <= LIMITE_WHATSAPP) {
                  parteActual += (parteActual ? "\n\n" : "") + p;
                } else {
                  if (parteActual) partes.push(parteActual);
                  if (p.length <= LIMITE_WHATSAPP) {
                    parteActual = p;
                  } else {
                    for (let i = 0; i < p.length; i += LIMITE_WHATSAPP) {
                      partes.push(p.slice(i, i + LIMITE_WHATSAPP));
                    }
                    parteActual = "";
                  }
                }
              }
              if (parteActual) partes.push(parteActual);
            }

            // Guardar respuesta del asistente en la sesión (texto completo)
            if (sesionId) {
              try {
                await conversacionManager.agregarMensaje(
                  sesionId,
                  "asistente",
                  respuestaParaGuardar,
                  resultado.herramientaUsada || "whatsapp",
                  resultado.clasificacion || null,
                  { tiempo_respuesta_ms: resultado.tiempoRespuesta || 0 },
                );
              } catch (msgError) {
                console.warn(
                  "⚠️ No se pudo guardar respuesta en sesión:",
                  msgError.message,
                );
              }
            }

            debugLog(
              `📤 [WhatsApp] Enviando respuesta (${respuestaParaGuardar.length} chars, ${partes.length} parte(s))`,
            );
            for (let i = 0; i < partes.length; i++) {
              await this.enviarMensajeSeguro(message, partes[i]);
              if (i < partes.length - 1) {
                await new Promise((r) => setTimeout(r, 800)); // Pausa entre mensajes para orden correcto
              }
            }
            infoLog(`✅ [Agente] Respuesta enviada`);
          } catch (error) {
            console.error("❌ Error al procesar mensaje con agente:", error);
            try {
              await this.enviarMensajeSeguro(
                message,
                "❌ Lo siento, hubo un error al procesar tu consulta. Por favor, intenta de nuevo.",
              );
            } catch (sendError) {
              console.error(
                "❌ Error crítico: No se pudo enviar ni siquiera el mensaje de error:",
                sendError,
              );
            }
          }
        } catch (error) {
          console.error("❌ Error en handler de mensajes WhatsApp:", error);
        }
      };

      const procesarChatsUnread = async () => {
        if (!this.client) return;
        const cutoff = this.serverStartTime || 0;
        // Ventana de búsqueda: buscar mensajes recientes aunque ya estén marcados como leídos.
        // En Railway, Chrome puede marcar mensajes como leídos antes de que el bot los procese,
        // por lo que NO podemos confiar solo en unreadCount > 0.
        const ventanaMs = Math.max(
          (this._unreadPollIntervalMs || 12000) * 3,
          60000,
        ); // mínimo 60s de ventana
        const recentCutoff = Date.now() - ventanaMs;
        const effectiveCutoff = Math.max(cutoff, recentCutoff);

        try {
          const chats = await this.client.getChats().catch(() => []);
          // Revisar chats con mensajes no leídos O con actividad reciente (por si Chrome los marcó como leídos)
          const chatsARevisar = (Array.isArray(chats) ? chats : []).filter(
            (c) => {
              if (!c) return false;
              if (c.unreadCount > 0) return true; // Claramente hay mensajes sin leer
              // También revisar chats con actividad reciente (Railway marca todo como leído)
              const lastTs = c.lastMessage?.timestamp;
              if (lastTs && lastTs * 1000 >= effectiveCutoff) return true;
              return false;
            },
          );

          if (chatsARevisar.length === 0) return;
          infoLog(
            `📬 [WhatsApp] Poll: revisando ${chatsARevisar.length} chat(s) con actividad reciente`,
          );

          for (const chat of chatsARevisar) {
            try {
              const msgs = await chat
                .fetchMessages({ limit: 5 })
                .catch(() => []);
              if (!Array.isArray(msgs) || msgs.length === 0) continue;
              for (const msg of msgs) {
                if (!msg || !msg.id || msg.fromMe) continue;
                // Filtrar por tiempo: solo mensajes dentro de la ventana
                if (
                  msg.timestamp != null &&
                  msg.timestamp * 1000 < effectiveCutoff
                )
                  continue;
                const from = typeof msg.from === "string" ? msg.from : "";
                if (
                  from === "status@broadcast" ||
                  (from && from.includes("@g.us"))
                )
                  continue;
                infoLog(
                  `📩 [WhatsApp POLL] Procesando mensaje id=${msg.id?._serialized?.slice(0, 30)} from=${from}`,
                );
                handlerMensaje(msg).catch((e) =>
                  console.warn("⚠️ [WhatsApp] Error en poll:", e.message),
                );
              }
            } catch (e) {
              console.warn(
                "⚠️ [WhatsApp] Error fetchMessages en poll:",
                e.message,
              );
            }
          }
        } catch (e) {
          console.warn(
            "⚠️ [WhatsApp] Error en procesarChatsUnread:",
            e.message,
          );
        }
      };

      const runUnreadPoll = async () => {
        if (this._unreadPollDone || !this.client) return;
        this._unreadPollDone = true;
        try {
          infoLog(
            "📬 [WhatsApp] Ejecutando poll inicial de mensajes recientes...",
          );
          await procesarChatsUnread();
        } catch (e) {
          this._unreadPollDone = false;
          console.warn("⚠️ [WhatsApp] Error en runUnreadPoll:", e.message);
        }
      };

      const startPeriodicUnreadPoll = () => {
        if (!this._unreadPollEnabled) {
          infoLog(
            "ℹ️ [WhatsApp] Poll deshabilitado - solo eventos tiempo real.",
          );
          return;
        }
        if (this._unreadPollInterval) return;
        this._unreadPollInterval = setInterval(() => {
          procesarChatsUnread().catch((e) =>
            console.warn("⚠️ [WhatsApp] Error en poll periódico:", e.message),
          );
        }, this._unreadPollIntervalMs);
        infoLog(
          `✅ [WhatsApp] Poll activo cada ${Math.round(this._unreadPollIntervalMs / 1000)}s (Railway: eventos + poll como mecanismo principal).`,
        );
      };

      try {
        // Registrar listeners ANTES de initialize() para evitar perder eventos.
        this.client.on("message", handlerMensaje);
        this.client.on("message_create", handlerMensaje);
        infoLog(
          "⚡ [WhatsApp] Modo tiempo real activo: respuesta inmediata por eventos de mensaje.",
        );
        // Fallback: mensajes que no emiten "message"/"message_create" (ej. primer mensaje de nuevo chat,
        // mensajes sincronizados al conectar). Al cambiar unread, obtenemos últimos mensajes y procesamos.
        this.client.on("unread_count", async (chat) => {
          try {
            if (!chat || !this.client) return;
            const cutoff = this.serverStartTime || 0;
            const msgs = await chat.fetchMessages({ limit: 5 }).catch(() => []);
            if (!Array.isArray(msgs) || msgs.length === 0) return;
            for (const msg of msgs) {
              if (!msg || !msg.id || msg.fromMe) continue;
              if (msg.timestamp != null && msg.timestamp * 1000 < cutoff)
                continue;
              const fr =
                toIdString(msg.from) ||
                (typeof msg.from === "string" ? msg.from : "");
              if (fr === "status@broadcast" || (fr && fr.includes("@g.us")))
                continue;
              handlerMensaje(msg).catch((e) =>
                console.warn(
                  "⚠️ [WhatsApp] Error procesando mensaje desde unread_count:",
                  e.message,
                ),
              );
            }
          } catch (e) {
            console.warn("⚠️ [WhatsApp] Error en unread_count:", e.message);
          }
        });
        infoLog(
          "✅ [WhatsApp] Listeners de mensajes y unread_count registrados",
        );

        try {
          await this.client.initialize();
        } catch (initErr) {
          if (
            initErr?.message &&
            initErr.message.includes("browser is already running") &&
            WHATSAPP_AUTO_KILL_CHROME_CFG !== false
          ) {
            infoLog(
              "⚠️ Navegador bloqueado, intentando liberar procesos Chrome...",
            );
            try {
              const { execSync } = require("child_process");
              if (process.platform === "win32") {
                try {
                  execSync("taskkill /F /IM chrome.exe 2>nul", {
                    stdio: "ignore",
                  });
                } catch (_) {}
                try {
                  execSync("taskkill /F /IM chromium.exe 2>nul", {
                    stdio: "ignore",
                  });
                } catch (_) {}
              } else {
                try {
                  execSync('pkill -f "chrome.*wwebjs" 2>/dev/null', {
                    stdio: "ignore",
                  });
                } catch (_) {}
              }
              await new Promise((r) => setTimeout(r, 2000));
              await this.client.initialize();
            } catch (retryErr) {
              throw initErr;
            }
          } else {
            throw initErr;
          }
        }
        infoLog("✅ [WhatsApp] Cliente inicializado");

        // Esperar un momento para ver si se genera el QR
        await new Promise((resolve) => setTimeout(resolve, 2000));

        if (this.qrCode) {
          infoLog("✅ [WhatsApp] QR disponible");
        } else {
          debugLog(
            "ℹ️ [WhatsApp] No hay QR (probablemente ya está autenticado)",
          );

          // Intentar obtener el número de teléfono autenticado
          try {
            const state = await this.client.getState();
            console.log(`📱 Estado de WhatsApp: ${state}`);

            if (state === "CONNECTED") {
              // Obtener información del cliente
              const info = await Promise.race([
                this.client.info,
                new Promise((_, reject) =>
                  setTimeout(
                    () => reject(new Error("Timeout obteniendo info")),
                    5000,
                  ),
                ),
              ]).catch((err) => {
                console.warn(
                  `⚠️ No se pudo obtener info del cliente: ${err.message}`,
                );
                return null;
              });

              if (info) {
                console.log("📱 Información del cliente autenticado:");
                console.log(
                  `   - wid: ${info.wid ? JSON.stringify(info.wid) : "N/A"}`,
                );

                // Intentar extraer el número de diferentes formas
                let numeroAutenticado = null;

                if (info.wid) {
                  if (info.wid.user) {
                    numeroAutenticado = info.wid.user;
                    console.log(`   - Número (wid.user): ${numeroAutenticado}`);
                  } else if (info.wid._serialized) {
                    numeroAutenticado = info.wid._serialized.split("@")[0];
                    console.log(
                      `   - Número (wid._serialized): ${numeroAutenticado}`,
                    );
                  } else if (typeof info.wid === "string") {
                    numeroAutenticado = info.wid.split("@")[0];
                    console.log(
                      `   - Número (wid string): ${numeroAutenticado}`,
                    );
                  }
                }

                if (info.pushname) {
                  console.log(`   - Nombre: ${info.pushname}`);
                }

                if (numeroAutenticado) {
                  const numeroNormalizado =
                    this.normalizarNumero(numeroAutenticado);
                  console.log(
                    `✅ Número autenticado: ${numeroAutenticado} -> Normalizado: ${numeroNormalizado}`,
                  );
                  this.phoneNumber = numeroAutenticado;
                } else {
                  console.warn(
                    `⚠️ No se pudo extraer el número del cliente autenticado`,
                  );
                  console.log(
                    `   Info completa:`,
                    JSON.stringify(info, null, 2),
                  );
                }
              } else {
                console.warn(`⚠️ No se pudo obtener información del cliente`);
              }

              this.serverStartTime = Date.now();
              console.log(
                `✅ Servidor listo (sin QR) - Solo se responden mensajes que lleguen a partir de ahora`,
              );
            }
          } catch (phoneError) {
            console.warn(
              `⚠️ Error al obtener número autenticado: ${phoneError.message}`,
            );
          }
        }
      } catch (initError) {
        console.error("❌ Error durante initialize():", initError.message);
        throw initError;
      }
      infoLog("✅ [WhatsApp] Cliente listo");
    } catch (error) {
      console.error("❌ Error al inicializar WhatsApp:", error.message);
      debugLog("Stack:", error.stack);

      if (
        error.message &&
        error.message.includes("browser is already running")
      ) {
        console.warn(
          "⚠️ El navegador de WhatsApp sigue abierto de una ejecución anterior.",
        );
        console.warn(
          '💡 Solución: Cierre esta terminal por completo y abra una nueva. O cierre procesos "Chrome" o "chromium" en el Administrador de tareas.',
        );
      } else if (
        error.message &&
        (error.message.includes("browser has disconnected") ||
          error.message.includes("Navigation failed") ||
          error.message.includes("destroyed") ||
          error.message.includes("context"))
      ) {
        console.warn(
          "⚠️ Error de navegador desconectado (probablemente temporal).",
        );
        console.warn(
          "💡 Intente reiniciar el backend. Si persiste, cierre la terminal y ábrala de nuevo.",
        );
      }

      // Limpiar en caso de error
      this.client = null;
      this.isReady = false;
      this.qrCode = null;
      this.qrImage = null;
      this.phoneNumber = null;

      // NO relanzar el error para que el servicio pueda continuar funcionando
      // (otros servicios como el formulario web de comprobantes seguirán funcionando)
      // throw error;
    } finally {
      this.initializing = false;
    }
  }

  // Función auxiliar para enviar mensajes de forma segura, manejando errores de WhatsApp Web.js
  async enviarMensajeSeguro(message, texto) {
    let chatId = message.from;
    if (typeof chatId !== "string" && chatId != null) {
      chatId =
        (chatId._serialized != null && String(chatId._serialized)) ||
        (chatId.user != null && String(chatId.user)) ||
        null;
    }
    if (!chatId) {
      console.warn(
        "⚠️ [enviarMensajeSeguro] No se pudo obtener chatId del mensaje",
      );
      return;
    }
    let mensajeEnviado = false;

    // Asegurar parche antes de intentar enviar
    await this.parchearSendSeen();

    // Estrategia 1: Intentar con message.reply() primero
    try {
      await message.reply(texto);
      mensajeEnviado = true;
      console.log("✅ Mensaje enviado con message.reply()");
      return; // Éxito
    } catch (error) {
      // Si el error NO es de markedUnread/sendSeen, relanzarlo
      if (
        error.message &&
        !error.message.includes("markedUnread") &&
        !error.message.includes("sendSeen") &&
        !error.message.includes("Cannot read properties of undefined") &&
        !error.message.includes("reading 'markedUnread'")
      ) {
        console.error("❌ Error diferente a markedUnread:", error.message);
        throw error;
      }
      // Si es error de markedUnread, continuar con estrategia 2
      console.warn(
        "⚠️ Error de markedUnread con message.reply(), intentando método alternativo...",
      );
    }

    // Estrategia 2: Enviar directamente con sendMessage (sin marcar como leído)
    // sendSeen: false evita el error markedUnread que ocurre ANTES del envío y bloquea la entrega
    try {
      console.log(
        "📤 Enviando mensaje directamente con sendMessage (sendSeen: false)...",
      );

      const sendPromise = this.client.sendMessage(chatId, texto, {
        sendSeen: false,
      });

      // Usar Promise.race con timeout para evitar que se quede colgado
      try {
        await Promise.race([
          sendPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), 20000),
          ),
        ]);
        mensajeEnviado = true;
        console.log("✅ Mensaje enviado correctamente con sendMessage");
        return;
      } catch (raceError) {
        // Si es timeout, relanzarlo
        if (raceError.message.includes("Timeout")) {
          console.error("❌ Timeout al enviar mensaje");
          throw new Error(
            "El envío del mensaje tardó demasiado. Por favor, intenta de nuevo.",
          );
        }

        // Si es error de markedUnread, el mensaje probablemente SÍ se envió
        // Verificar si el error viene del sendSeen interno
        if (
          raceError.message &&
          (raceError.message.includes("markedUnread") ||
            raceError.message.includes("sendSeen") ||
            raceError.message.includes("Cannot read properties of undefined") ||
            raceError.message.includes("reading 'markedUnread'"))
        ) {
          // El mensaje probablemente se envió, solo falló al marcar como leído
          console.warn(
            "⚠️ Error de markedUnread al enviar, pero el mensaje probablemente se envió",
          );
          mensajeEnviado = true;
          return; // Considerar éxito parcial
        }

        // Otros errores se relanzan
        throw raceError;
      }
    } catch (sendError) {
      // Si el error es específicamente de markedUnread/sendSeen, verificar si el mensaje se envió
      if (
        sendError.message &&
        (sendError.message.includes("markedUnread") ||
          sendError.message.includes("sendSeen") ||
          sendError.message.includes("Cannot read properties of undefined") ||
          sendError.message.includes("reading 'markedUnread'"))
      ) {
        console.warn(
          "⚠️ Error de markedUnread detectado, pero el mensaje probablemente se envió correctamente",
        );
        // No relanzar el error - asumir que el mensaje se envió
        return;
      }

      // Si es timeout u otro error, relanzarlo
      if (sendError.message.includes("Timeout")) {
        console.error("❌ Timeout al enviar mensaje");
        throw new Error(
          "El envío del mensaje tardó demasiado. Por favor, intenta de nuevo.",
        );
      }

      // Otros errores se relanzan
      console.error("❌ Error al enviar mensaje:", sendError.message);
      throw sendError;
    }
  }

  getQRCode() {
    return this.qrCode;
  }

  getQRImage() {
    return this.qrImage;
  }

  async isClientReady() {
    // Si ya está marcado como listo, verificar que realmente lo esté
    if (this.isReady && this.client) {
      try {
        const state = await this.client.getState();
        if (state === "CONNECTED") {
          // Si el estado es CONNECTED, está listo (incluso si info no está disponible)
          // Intentar obtener número en segundo plano si no lo tenemos
          if (!this.phoneNumber) {
            this.obtenerNumeroTelefono().catch(() => {});
          }
          return true;
        } else {
          this.isReady = false;
          return false;
        }
      } catch (error) {
        this.isReady = false;
        return false;
      }
    }

    // Si no está marcado como listo pero hay cliente, verificar si realmente está conectado
    if (this.client && !this.isReady) {
      try {
        const state = await this.client.getState();
        if (state === "CONNECTED") {
          // Si el estado es CONNECTED, marcar como listo
          this.isReady = true;
          this.qrCode = null;
          this.qrImage = null;

          // Intentar obtener número en segundo plano
          this.obtenerNumeroTelefono().catch(() => {});

          return true;
        }
      } catch (error) {
        // Si hay error, no está listo aún
        return false;
      }
    }

    return this.isReady;
  }

  // Método auxiliar para obtener el número de teléfono en segundo plano
  async obtenerNumeroTelefono() {
    if (!this.client || this.phoneNumber) {
      return; // Ya tenemos el número o no hay cliente
    }

    // Intentar múltiples veces con esperas progresivas
    for (let intento = 1; intento <= 15; intento++) {
      try {
        await new Promise((resolve) => setTimeout(resolve, intento * 500)); // Esperar progresivamente más

        const info = await Promise.race([
          this.client.info,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), 5000),
          ),
        ]);

        if (info?.wid) {
          if (info.wid.user) {
            this.phoneNumber = info.wid.user;
            return;
          } else if (info.wid.toString) {
            // Extraer el número del wid si viene como string
            const widString = info.wid.toString();
            this.phoneNumber = widString
              .replace("@c.us", "")
              .replace("@s.whatsapp.net", "");
            return;
          }
        }
      } catch (error) {
        // Continuar intentando
      }
    }
  }

  // Normalizar número de teléfono para WhatsApp (copiado de ocrComprobantesPublicRoutes)
  normalizarNumero(numero) {
    if (!numero) return null;
    let normalizado = String(numero).replace(/\D/g, "");
    if (normalizado.startsWith("591")) {
      normalizado = normalizado.substring(3);
    }
    if (String(numero).startsWith("+591")) {
      normalizado = String(numero).replace(/\+591/g, "").replace(/\D/g, "");
    }
    return normalizado;
  }

  // Enviar mensaje directamente a un número de teléfono (sin mensaje previo)
  async enviarMensajeANumero(numero, texto) {
    console.log(
      `🔍 [enviarMensajeANumero] Iniciando envío a número: ${numero}`,
    );

    if (!this.client) {
      console.error("❌ [enviarMensajeANumero] Cliente de WhatsApp es null");
      throw new Error("WhatsApp no está conectado (cliente es null)");
    }

    const isReady = await this.isClientReady();
    console.log(`🔍 [enviarMensajeANumero] WhatsApp está listo: ${isReady}`);

    if (!isReady) {
      console.error(
        "❌ [enviarMensajeANumero] WhatsApp no está listo (isReady = false)",
      );
      throw new Error("WhatsApp no está conectado (isReady = false)");
    }

    const numeroNormalizado = this.normalizarNumero(numero);
    console.log(
      `🔍 [enviarMensajeANumero] Número normalizado: ${numeroNormalizado} (original: ${numero})`,
    );

    if (!numeroNormalizado || numeroNormalizado.length < 7) {
      console.error(
        `❌ [enviarMensajeANumero] Número inválido: ${numeroNormalizado} (longitud: ${numeroNormalizado?.length || 0})`,
      );
      throw new Error(
        `Número de teléfono inválido: ${numero} -> ${numeroNormalizado}`,
      );
    }

    try {
      console.log(`🔍 [enviarMensajeANumero] Aplicando parche sendSeen...`);
      await this.parchearSendSeen();

      // Obtener el ID válido del número (necesario para evitar error "No LID for user")
      // Formato: 591XXXXXXXXX (código de país + número)
      const numeroConCodigoPais = numeroNormalizado.startsWith("591")
        ? numeroNormalizado
        : `591${numeroNormalizado}`;

      console.log(
        `🔍 [enviarMensajeANumero] Obteniendo ID válido para número: ${numeroConCodigoPais}...`,
      );

      let chatId;
      try {
        // Intentar obtener el ID válido del número
        const numberId = await this.client.getNumberId(numeroConCodigoPais);

        if (numberId) {
          chatId = numberId._serialized || numberId;
          console.log(
            `✅ [enviarMensajeANumero] ID válido obtenido: ${chatId}`,
          );
        } else {
          // Si no se puede obtener el ID, usar formato estándar
          chatId = `${numeroConCodigoPais}@c.us`;
          console.log(
            `⚠️ [enviarMensajeANumero] No se pudo obtener ID válido, usando formato estándar: ${chatId}`,
          );
        }
      } catch (getIdError) {
        // Si falla obtener el ID, intentar con formato estándar
        console.warn(
          `⚠️ [enviarMensajeANumero] Error obteniendo ID válido: ${getIdError.message}, usando formato estándar`,
        );
        chatId = `${numeroConCodigoPais}@c.us`;
      }

      console.log(`🔍 [enviarMensajeANumero] Enviando mensaje a: ${chatId}...`);
      const resultado = await this.client.sendMessage(chatId, texto);

      console.log(
        `✅ [enviarMensajeANumero] Mensaje enviado exitosamente a ${numeroNormalizado} (${chatId})`,
      );
      console.log(`   Resultado:`, resultado ? "OK" : "Sin resultado");
      return true;
    } catch (error) {
      console.error(
        `❌ [enviarMensajeANumero] Error enviando mensaje a ${numeroNormalizado}:`,
      );
      console.error(`   Mensaje de error: ${error.message}`);
      console.error(`   Stack:`, error.stack);

      // Si el error es "No LID for user", intentar con formato alternativo
      if (error.message && error.message.includes("LID")) {
        console.log(
          `🔄 [enviarMensajeANumero] Intentando método alternativo para número sin LID...`,
        );
        try {
          // Intentar obtener el chat directamente
          const chat = await this.client
            .getChatById(`${numeroNormalizado}@c.us`)
            .catch(() => null);
          if (chat) {
            await chat.sendMessage(texto);
            console.log(
              `✅ [enviarMensajeANumero] Mensaje enviado usando método alternativo`,
            );
            return true;
          }
        } catch (altError) {
          console.error(
            `❌ [enviarMensajeANumero] Método alternativo también falló: ${altError.message}`,
          );
        }
      }

      throw error;
    }
  }

  // Enviar un PDF por WhatsApp a un número de teléfono
  async enviarPDFANumero(numero, pdfAbsolutePath, caption = "") {
    if (!this.client) {
      throw new Error("WhatsApp no está conectado (cliente es null)");
    }

    const isReady = await this.isClientReady();
    if (!isReady) {
      throw new Error("WhatsApp no está conectado (isReady = false)");
    }

    const numeroNormalizado = this.normalizarNumero(numero);
    if (!numeroNormalizado || numeroNormalizado.length < 7) {
      throw new Error(`Número de teléfono inválido: ${numero}`);
    }

    // Validar archivo
    if (!pdfAbsolutePath) {
      throw new Error("Ruta del PDF inválida");
    }

    // Asegurar parche antes de enviar
    await this.parchearSendSeen();

    const numeroConCodigoPais = numeroNormalizado.startsWith("591")
      ? numeroNormalizado
      : `591${numeroNormalizado}`;

    let chatId;
    try {
      const numberId = await this.client.getNumberId(numeroConCodigoPais);
      if (numberId) {
        chatId = numberId._serialized || numberId;
      } else {
        chatId = `${numeroConCodigoPais}@c.us`;
      }
    } catch (_) {
      chatId = `${numeroConCodigoPais}@c.us`;
    }

    const media = MessageMedia.fromFilePath(pdfAbsolutePath);
    await this.client.sendMessage(chatId, media, {
      caption: caption || undefined,
      sendSeen: false,
    });
    return true;
  }

  async getPhoneNumber() {
    // Si no tenemos el número pero el cliente está listo, intentar obtenerlo
    if (!this.phoneNumber && this.client) {
      try {
        const state = await this.client.getState();
        if (state === "CONNECTED") {
          try {
            const info = await Promise.race([
              this.client.info,
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Timeout")), 3000),
              ),
            ]);

            if (info?.wid?.user) {
              this.phoneNumber = info.wid.user;
            } else if (info?.wid?.toString) {
              // Extraer el número del wid si viene como string
              const widString = info.wid.toString();
              this.phoneNumber = widString
                .replace("@c.us", "")
                .replace("@s.whatsapp.net", "");
            }
          } catch (error) {
            // Ignorar errores silenciosamente
          }
        }
      } catch (stateError) {
        // Ignorar errores de estado
      }
    }
    return this.phoneNumber;
  }

  /**
   * Cierra el cliente y el navegador sin hacer logout (mantiene sesión para próxima ejecución).
   * IMPORTANTE: Llamar antes de que el proceso termine para evitar "browser is already running".
   */
  async destroy() {
    if (!this.client) return;
    const clientToDestroy = this.client;
    this.client = null;
    this.isReady = false;
    this.qrCode = null;
    this.qrImage = null;
    this.phoneNumber = null;
    if (this._unreadPollInterval) {
      clearInterval(this._unreadPollInterval);
      this._unreadPollInterval = null;
    }
    try {
      await Promise.race([
        clientToDestroy.destroy(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 8000),
        ),
      ]);
    } catch (e) {
      // Ignorar - el proceso está terminando
    }
  }

  async logout() {
    if (!this.client) {
      return;
    }

    const clientToDestroy = this.client;

    try {
      // Resetear estado inmediatamente
      this.isReady = false;
      this.qrCode = null;
      this.qrImage = null;
      this.phoneNumber = null;
      this.client = null;

      // Cerrar sesión y destruir cliente (sin bloquear y manejando errores)
      Promise.race([
        clientToDestroy.logout(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 3000),
        ),
      ])
        .catch(() => {
          // Ignorar errores de logout silenciosamente
        })
        .finally(() => {
          // Intentar destruir el cliente
          Promise.race([
            clientToDestroy.destroy(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("Timeout")), 5000),
            ),
          ]).catch(() => {
            // Ignorar errores de destrucción silenciosamente
          });
        });
    } catch (error) {
      // Capturar cualquier error síncrono
      console.error("Error en logout:", error.message);
      this.client = null;
    }
  }

  // Normalizar número de teléfono (eliminar espacios, guiones, etc.)
  normalizarNumero(numero) {
    if (!numero) {
      return "";
    }

    // Eliminar todo excepto dígitos
    let normalizado = numero.toString().replace(/\D/g, "");

    // CRÍTICO: WhatsApp puede enviar números en formato internacional largo
    // Si el número tiene más de 10 dígitos, probablemente incluye código de país

    // Si empieza con 591 (código de país de Bolivia) y tiene más de 8 dígitos, quitar el 591
    if (normalizado.startsWith("591") && normalizado.length > 8) {
      normalizado = normalizado.substring(3);
    }

    // Si empieza con 214 (posible prefijo de WhatsApp Web), quitar los primeros dígitos
    // WhatsApp Web a veces envía números como 214014512648382 que incluyen prefijos
    if (normalizado.startsWith("214") && normalizado.length > 10) {
      // Intentar extraer el número real (últimos 8-10 dígitos)
      // Los números bolivianos tienen 8 dígitos (ej: 62556840)
      const ultimosDigitos = normalizado.substring(normalizado.length - 8);
      if (
        (ultimosDigitos.length === 8 && ultimosDigitos.startsWith("6")) ||
        ultimosDigitos.startsWith("7")
      ) {
        normalizado = ultimosDigitos;
      }
    }

    // Si empieza con +591, quitar el +591
    if (numero.toString().startsWith("+591")) {
      normalizado = numero.toString().replace(/\+591/g, "").replace(/\D/g, "");
    }

    // Si después de todo el proceso el número tiene más de 8 dígitos y empieza con 591, quitar 591
    if (normalizado.length > 8 && normalizado.startsWith("591")) {
      normalizado = normalizado.substring(3);
    }

    debugLog(
      `🔧 [normalizarNumero] Original: ${numero} -> Normalizado: ${normalizado} (longitud: ${normalizado.length})`,
    );
    return normalizado;
  }

  // Buscar información del remitente en la base de datos
  async buscarRemitenteEnBD(numeroNormalizado, pool) {
    try {
      if (!pool || !numeroNormalizado || numeroNormalizado.length < 7) {
        console.log(
          `⚠️ [buscarRemitenteEnBD] Parámetros inválidos - pool: ${!!pool}, numero: ${numeroNormalizado}, longitud: ${numeroNormalizado?.length || 0}`,
        );
        return null;
      }

      console.log(
        `🔍 [buscarRemitenteEnBD] Buscando remitente con número normalizado: ${numeroNormalizado}`,
      );

      // CRÍTICO: Normalizar también el número para la búsqueda, eliminando todos los caracteres no numéricos
      // Esto asegura que la búsqueda funcione incluso si los números en la BD tienen diferentes formatos
      const numeroParaBuscar = numeroNormalizado.replace(/\D/g, "");
      console.log(
        `🔍 [buscarRemitenteEnBD] Número para búsqueda (solo dígitos): ${numeroParaBuscar}`,
      );

      // Buscar en todos los campos de teléfono posibles
      // CRÍTICO: Normalizar también los números de la BD para comparar
      const [resultados] = await pool.query(
        `
        SELECT
          e.id,
          e.nombre_padre,
          e.apellido_padre,
          e.nombre_madre,
          e.apellido_madre,
          e.nombre_autorizado1,
          e.nombre_autorizado2,
          e.nombre as nombre_estudiante,
          e.apellido_paterno,
          e.apellido_materno,
          e.telefono_domicilio_padre,
          e.telefono_oficina_padre,
          e.telefono_domicilio_madre,
          e.telefono_oficina_madre,
          CASE
            WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_padre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? THEN 'padre_domicilio'
            WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_padre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? THEN 'padre_oficina'
            WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_madre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? THEN 'madre_domicilio'
            WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_madre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? THEN 'madre_oficina'
            WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado1, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? THEN 'autorizado1'
            WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado2, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? THEN 'autorizado2'
          END as tipo_telefono
        FROM estudiantes e
        WHERE
          REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_padre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
          OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_padre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
          OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_madre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
          OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_madre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
          OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado1, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
          OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado2, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
        ORDER BY e.id ASC
        LIMIT 1
      `,
        [
          `%${numeroParaBuscar}%`,
          `%${numeroParaBuscar}%`,
          `%${numeroParaBuscar}%`,
          `%${numeroParaBuscar}%`,
          `%${numeroParaBuscar}%`,
          `%${numeroParaBuscar}%`,
          `%${numeroParaBuscar}%`,
          `%${numeroParaBuscar}%`,
          `%${numeroParaBuscar}%`,
          `%${numeroParaBuscar}%`,
          `%${numeroParaBuscar}%`,
          `%${numeroParaBuscar}%`,
        ],
      );

      console.log(
        `🔍 [buscarRemitenteEnBD] Resultados encontrados: ${resultados?.length || 0}`,
      );

      // Si no se encontraron resultados, intentar búsqueda más flexible
      if (
        (!resultados || resultados.length === 0) &&
        numeroParaBuscar.length >= 8
      ) {
        // Intentar buscar solo con los últimos 8 dígitos (formato típico de números bolivianos)
        const ultimos8Digitos = numeroParaBuscar.substring(
          numeroParaBuscar.length - 8,
        );
        console.log(
          `🔍 [buscarRemitenteEnBD] Intentando búsqueda alternativa con últimos 8 dígitos: ${ultimos8Digitos}`,
        );

        const [resultadosAlt] = await pool.query(
          `
          SELECT
            e.id,
            e.nombre_padre,
            e.apellido_padre,
            e.nombre_madre,
            e.apellido_madre,
            e.nombre_autorizado1,
            e.nombre_autorizado2,
            e.nombre as nombre_estudiante,
            e.apellido_paterno,
            e.apellido_materno,
            e.telefono_domicilio_padre,
            e.telefono_oficina_padre,
            e.telefono_domicilio_madre,
            e.telefono_oficina_madre,
            CASE
              WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_padre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? THEN 'padre_domicilio'
              WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_padre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? THEN 'padre_oficina'
              WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_madre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? THEN 'madre_domicilio'
              WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_madre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? THEN 'madre_oficina'
              WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado1, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? THEN 'autorizado1'
              WHEN REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado2, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ? THEN 'autorizado2'
            END as tipo_telefono
          FROM estudiantes e
          WHERE
            REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_padre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_padre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_domicilio_madre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_oficina_madre, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado1, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(e.telefono_autorizado2, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?
          ORDER BY e.id ASC
          LIMIT 1
        `,
          [
            `%${ultimos8Digitos}%`,
            `%${ultimos8Digitos}%`,
            `%${ultimos8Digitos}%`,
            `%${ultimos8Digitos}%`,
            `%${ultimos8Digitos}%`,
            `%${ultimos8Digitos}%`,
            `%${ultimos8Digitos}%`,
            `%${ultimos8Digitos}%`,
            `%${ultimos8Digitos}%`,
            `%${ultimos8Digitos}%`,
            `%${ultimos8Digitos}%`,
            `%${ultimos8Digitos}%`,
          ],
        );

        if (resultadosAlt && resultadosAlt.length > 0) {
          console.log(
            `✅ [buscarRemitenteEnBD] Remitente encontrado con búsqueda alternativa (últimos 8 dígitos)`,
          );
          resultados = resultadosAlt;
        }
      }

      if (resultados && resultados.length > 0) {
        // CRÍTICO: Devolver solo el primer estudiante para evitar confusión
        // Si un padre tiene múltiples hijos, usaremos solo el primero
        const resultado = resultados[0];
        console.log(`✅ [buscarRemitenteEnBD] Remitente encontrado:`);
        console.log(
          `   - Nombre: ${resultado.nombre_padre || resultado.nombre_madre || resultado.nombre_autorizado1 || "N/A"}`,
        );
        console.log(
          `   - Estudiante: ${resultado.nombre_estudiante} ${resultado.apellido_paterno || ""}`,
        );
        console.log(`   - Tipo teléfono: ${resultado.tipo_telefono}`);
        console.log(
          `   - Total estudiantes relacionados: ${resultados.length}`,
        );

        return {
          id_estudiante: resultado.id,
          nombre_padre: resultado.nombre_padre,
          apellido_padre: resultado.apellido_padre,
          nombre_madre: resultado.nombre_madre,
          apellido_madre: resultado.apellido_madre,
          nombre_autorizado:
            resultado.nombre_autorizado1 || resultado.nombre_autorizado2,
          nombre_estudiante: resultado.nombre_estudiante,
          apellido_paterno: resultado.apellido_paterno,
          apellido_materno: resultado.apellido_materno,
          tipo_telefono: resultado.tipo_telefono,
        };
      }

      console.log(
        `⚠️ [buscarRemitenteEnBD] No se encontró remitente en BD para número: ${numeroNormalizado} (búsqueda: ${numeroParaBuscar})`,
      );
      console.log(
        `💡 [buscarRemitenteEnBD] Verificar que el número esté registrado en los campos:`,
      );
      console.log(`   - telefono_domicilio_padre`);
      console.log(`   - telefono_oficina_padre`);
      console.log(`   - telefono_domicilio_madre`);
      console.log(`   - telefono_oficina_madre`);
      console.log(`   - telefono_autorizado1`);
      console.log(`   - telefono_autorizado2`);
      return null;
    } catch (error) {
      console.error(
        "❌ [buscarRemitenteEnBD] Error al buscar remitente en BD:",
        error.message,
      );
      console.error("Stack:", error.stack);
      return null;
    }
  }
}

module.exports = WhatsAppService;

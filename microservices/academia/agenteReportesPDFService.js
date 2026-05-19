// ===== SERVICIO DE GENERACIÓN DE REPORTES PDF PARA EL AGENTE INTELIGENTE =====
// Genera reportes PDF profesionales de la base de datos bajo demanda del agente

const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const pool = require("./config");

// Directorio para PDFs generados por el agente
const REPORTES_DIR = path.join(process.cwd(), "pdfs", "reportes_agente");
if (!fs.existsSync(REPORTES_DIR)) {
  fs.mkdirSync(REPORTES_DIR, { recursive: true });
}

// Colores institucionales
const COLORS = {
  primary: "#1a5276",
  accent: "#f39c12",
  headerRow: "#1a5276",
  altRow: "#eaf4fb",
  text: "#1c2833",
  subtext: "#566573",
  danger: "#922b21",
  warning: "#b7950b",
};

function formatMonto(v) {
  return `Bs. ${parseFloat(v || 0).toFixed(2)}`;
}

function formatFecha(f) {
  if (!f) return "-";
  return new Date(f).toLocaleDateString("es-BO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// ────────────────────────────────────────────────
// Encabezado institucional
// ────────────────────────────────────────────────
function dibujarEncabezado(doc, titulo, subtitulo) {
  const W = doc.page.width;

  // Barra azul superior
  doc.rect(0, 0, W, 68).fill(COLORS.primary);

  doc
    .fillColor("white")
    .fontSize(15)
    .font("Helvetica-Bold")
    .text("UNIDAD EDUCATIVA SINAI MONTESSORI", 40, 14, { align: "left" });

  doc
    .fontSize(9)
    .font("Helvetica")
    .text("Sistema de Gestión Educativa", 40, 36);

  const ahora = new Date().toLocaleString("es-BO", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  doc
    .fontSize(8)
    .text(`Generado: ${ahora}`, W - 200, 30, { width: 160, align: "right" });

  // Línea dorada
  doc.rect(0, 68, W, 4).fill(COLORS.accent);

  // Título del reporte
  doc
    .fillColor(COLORS.primary)
    .fontSize(14)
    .font("Helvetica-Bold")
    .text(titulo, 40, 86, { align: "center", width: W - 80 });

  if (subtitulo) {
    doc
      .fillColor(COLORS.subtext)
      .fontSize(9)
      .font("Helvetica")
      .text(subtitulo, 40, 106, { align: "center", width: W - 80 });
  }

  // Línea separadora
  doc
    .moveTo(40, 124)
    .lineTo(W - 40, 124)
    .strokeColor("#bdc3c7")
    .lineWidth(0.5)
    .stroke();
  doc.y = 134;
}

// ────────────────────────────────────────────────
// Pie de página
// ────────────────────────────────────────────────
function dibujarPiePagina(doc) {
  const W = doc.page.width;
  const H = doc.page.height;
  doc.rect(0, H - 32, W, 32).fill(COLORS.primary);
  doc
    .fillColor("white")
    .fontSize(7)
    .font("Helvetica")
    .text(
      "Unidad Educativa Sinai Montessori — Documento generado automáticamente por el Agente Inteligente",
      40,
      H - 20,
      { align: "left" },
    )
    .text("CONFIDENCIAL", W - 110, H - 20, { width: 70, align: "right" });
  // 🔧 Restablecer doc.y para evitar que PDFKit agregue páginas en blanco adicionales
  // Si doc.y está cerca del fondo, PDFKit auto-agrega una página extra
  // Lo fijamos justo arriba del footer para que no haya desbordamiento
  doc.y = H - 35;
}

// ────────────────────────────────────────────────
// Tabla genérica con paginación automática
// ────────────────────────────────────────────────
function dibujarTabla(doc, headers, rows, colWidths, opts = {}) {
  const X = 40;
  const W = colWidths.reduce((a, b) => a + b, 0);
  const ROW_H = opts.rowHeight || 20;
  const HDR_H = 24;

  const dibujarCabecera = (y) => {
    doc.rect(X, y, W, HDR_H).fill(COLORS.headerRow);
    doc.fillColor("white").fontSize(8).font("Helvetica-Bold");
    let xc = X;
    headers.forEach((h, i) => {
      doc.text(h, xc + 4, y + 7, {
        width: colWidths[i] - 8,
        align: opts.hAlign?.[i] || "center",
        lineBreak: false,
      });
      xc += colWidths[i];
    });
    return y + HDR_H;
  };

  let y = dibujarCabecera(doc.y);

  rows.forEach((row, ri) => {
    // Nueva página si no hay espacio
    if (y + ROW_H > doc.page.height - 50) {
      dibujarPiePagina(doc);
      doc.addPage();
      dibujarEncabezadoContinuacion(doc);
      y = dibujarCabecera(doc.y);
    }

    const bg = ri % 2 === 0 ? "white" : COLORS.altRow;
    doc.rect(X, y, W, ROW_H).fill(bg);
    doc.rect(X, y, W, ROW_H).strokeColor("#d5d8dc").lineWidth(0.3).stroke();

    doc.font("Helvetica").fontSize(8);
    let xc = X;
    row.forEach((cell, ci) => {
      const txt = cell !== null && cell !== undefined ? String(cell) : "-";
      const color = opts.cellColor?.[ci]?.(txt) || COLORS.text;
      doc.fillColor(color).text(txt, xc + 4, y + 5, {
        width: colWidths[ci] - 8,
        align: opts.cAlign?.[ci] || "left",
        lineBreak: false,
        ellipsis: true,
      });
      xc += colWidths[ci];
    });
    y += ROW_H;
  });

  doc.y = y + 6;
}

function dibujarEncabezadoContinuacion(doc) {
  doc.y = 40;
  doc
    .fillColor(COLORS.primary)
    .fontSize(8)
    .font("Helvetica-Oblique")
    .text("(continuación)", 40, 30, {
      align: "center",
      width: doc.page.width - 80,
    });
  doc.y = 46;
}

// ════════════════════════════════════════════════
// REPORTE 1 — Lista de estudiantes por nivel/turno
// ════════════════════════════════════════════════
async function generarReporteEstudiantesPorNivel({
  nivel_id,
  turno,
  gestion_academica,
  nivel_nombre,
  turno_label,
}) {
  const anio = gestion_academica || new Date().getFullYear();

  let where = 'WHERE i.gestion_academica = ? AND i.estado = "activo"';
  const params = [anio];

  if (nivel_id) {
    where += " AND i.nivel_id = ?";
    params.push(nivel_id);
  }
  if (turno) {
    where += " AND (LOWER(COALESCE(i.turno, c.turno)) LIKE ?)";
    params.push(`%${turno.toLowerCase()}%`);
  }

  const [rows] = await pool.query(
    `
    SELECT
      e.nombre, e.apellido_paterno, e.apellido_materno, e.ci_estudiante,
      n.nombre  AS nivel_nombre,
      COALESCE(i.turno, c.turno, '-') AS turno,
      c.hora_inicio, c.hora_fin,
      e.nombre_padre, e.apellido_padre,
      e.nombre_madre, e.apellido_madre,
      e.telefono_domicilio_padre
    FROM inscripciones i
    JOIN estudiantes e  ON e.id  = i.estudiante_id
    LEFT JOIN nivel n   ON n.id  = i.nivel_id
    LEFT JOIN curso c   ON c.id  = i.curso_id
    ${where}
    ORDER BY n.nombre, e.apellido_paterno, e.nombre
  `,
    params,
  );

  if (!rows.length) {
    return {
      ok: false,
      message: "No se encontraron estudiantes con esos filtros.",
    };
  }

  const nombreArchivo = `estudiantes-${(nivel_nombre || "todos").replace(/\s+/g, "-")}-${turno_label || "all"}-${anio}-${Date.now()}.pdf`;
  const rutaPDF = path.join(REPORTES_DIR, nombreArchivo);

  const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
  const stream = fs.createWriteStream(rutaPDF);
  doc.pipe(stream);

  const titulo = `Lista de Estudiantes — ${nivel_nombre || "Todos los Niveles"}${turno_label ? ` | Turno ${turno_label}` : ""}`;
  dibujarEncabezado(
    doc,
    titulo,
    `Gestión ${anio}  •  Total: ${rows.length} estudiante(s)`,
  );

  const headers = [
    "#",
    "Apellidos",
    "Nombre",
    "CI",
    "Nivel",
    "Turno",
    "Horario",
    "Tutor / Teléfono",
  ];
  const colWidths = [28, 170, 110, 65, 100, 60, 80, 185];

  const tableRows = rows.map((r, i) => {
    const horario =
      r.hora_inicio && r.hora_fin
        ? `${String(r.hora_inicio).slice(0, 5)} - ${String(r.hora_fin).slice(0, 5)}`
        : "-";
    const tutor = r.nombre_padre
      ? `${r.nombre_padre} ${r.apellido_padre || ""}`.trim() +
        (r.telefono_domicilio_padre ? `\n${r.telefono_domicilio_padre}` : "")
      : r.nombre_madre
        ? `${r.nombre_madre}`.trim()
        : "-";
    return [
      i + 1,
      `${r.apellido_paterno || ""} ${r.apellido_materno || ""}`.trim(),
      r.nombre || "-",
      r.ci_estudiante || "-",
      r.nivel_nombre || "-",
      r.turno || "-",
      horario,
      tutor,
    ];
  });

  dibujarTabla(doc, headers, tableRows, colWidths, {
    hAlign: [
      "center",
      "left",
      "left",
      "center",
      "left",
      "center",
      "center",
      "left",
    ],
    cAlign: [
      "center",
      "left",
      "left",
      "center",
      "left",
      "center",
      "center",
      "left",
    ],
  });

  // Resumen por nivel — solo si hay espacio suficiente (evitar página en blanco)
  const byNivel = {};
  rows.forEach((r) => {
    const k = r.nivel_nombre || "Sin nivel";
    byNivel[k] = (byNivel[k] || 0) + 1;
  });
  const lineasResumen = Object.keys(byNivel).length;
  const espacioNecesario = 20 + lineasResumen * 14 + 40; // título + filas + margen
  if (doc.y + espacioNecesario < doc.page.height - 70) {
    doc.moveDown(0.3);
    doc
      .fillColor(COLORS.primary)
      .fontSize(9)
      .font("Helvetica-Bold")
      .text("Resumen:", 40);
    doc.font("Helvetica").fontSize(8).fillColor(COLORS.text);
    Object.entries(byNivel).forEach(([k, v]) =>
      doc.text(`  • ${k}: ${v} estudiante(s)`, 40),
    );
  }

  dibujarPiePagina(doc);
  doc.end();

  return new Promise((res, rej) => {
    stream.on("finish", () =>
      res({
        ok: true,
        rutaPDF,
        nombreArchivo,
        total: rows.length,
        tipo: "estudiantes",
      }),
    );
    stream.on("error", rej);
  });
}

// ════════════════════════════════════════════════
// REPORTE 2 — Pagos pendientes
// ════════════════════════════════════════════════
async function generarReportePagosPendientes({
  nivel_id,
  turno,
  gestion_academica,
  nivel_nombre,
  turno_label,
}) {
  const anio = gestion_academica || new Date().getFullYear();

  let whereExtra = "";
  const params = [anio];

  if (nivel_id) {
    whereExtra += " AND i.nivel_id = ?";
    params.push(nivel_id);
  }
  if (turno) {
    whereExtra += " AND LOWER(COALESCE(i.turno, c.turno)) LIKE ?";
    params.push(`%${turno.toLowerCase()}%`);
  }

  const [rows] = await pool.query(
    `
    SELECT
      e.nombre, e.apellido_paterno, e.apellido_materno,
      n.nombre  AS nivel_nombre,
      COALESCE(i.turno, c.turno, '-') AS turno,
      pm.nombre_mes,
      pm.monto_esperado,
      COALESCE(SUM(pr.monto), 0)                           AS monto_pagado,
      (pm.monto_esperado - COALESCE(SUM(pr.monto), 0))    AS monto_pendiente,
      pm.estado,
      pm.fecha_vencimiento
    FROM pagos_mensuales pm
    JOIN compromiso_economico ce ON pm.id_compromiso  = ce.id
    JOIN inscripciones i         ON ce.id_inscripcion = i.id
    JOIN estudiantes e           ON i.estudiante_id   = e.id
    LEFT JOIN nivel n            ON n.id  = i.nivel_id
    LEFT JOIN curso c            ON c.id  = i.curso_id
    LEFT JOIN pagos_realizados pr ON pr.id_compromiso = ce.id AND pr.mes = pm.nombre_mes
    WHERE i.gestion_academica = ?
      AND pm.estado IN ('pendiente','parcial','vencido')
      ${whereExtra}
    GROUP BY pm.id, e.id, n.nombre, i.turno, c.turno, pm.nombre_mes, pm.monto_esperado, pm.estado, pm.fecha_vencimiento
    HAVING monto_pendiente > 0
    ORDER BY e.apellido_paterno, e.nombre, pm.mes
  `,
    params,
  );

  if (!rows.length) {
    return {
      ok: false,
      message:
        "¡Excelente! No hay pagos pendientes con esos filtros. Todo está al día.",
    };
  }

  const totalPendiente = rows.reduce(
    (s, r) => s + parseFloat(r.monto_pendiente || 0),
    0,
  );

  const nombreArchivo = `pagos-pendientes-${(nivel_nombre || "todos").replace(/\s+/g, "-")}-${anio}-${Date.now()}.pdf`;
  const rutaPDF = path.join(REPORTES_DIR, nombreArchivo);

  const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
  const stream = fs.createWriteStream(rutaPDF);
  doc.pipe(stream);

  const titulo = `Reporte de Pagos Pendientes — ${nivel_nombre || "Todos los Niveles"}${turno_label ? ` | Turno ${turno_label}` : ""}`;
  dibujarEncabezado(
    doc,
    titulo,
    `Gestión ${anio}  •  ${rows.length} cuota(s) pendientes  •  Total: ${formatMonto(totalPendiente)}`,
  );

  const headers = [
    "#",
    "Estudiante",
    "Nivel",
    "Turno",
    "Mes",
    "Esperado",
    "Pagado",
    "Pendiente",
    "Estado",
    "Vencimiento",
  ];
  const colWidths = [28, 185, 90, 60, 68, 68, 68, 68, 65, 78];

  const tableRows = rows.map((r, i) => [
    i + 1,
    `${r.apellido_paterno || ""} ${r.apellido_materno || ""}, ${r.nombre || ""}`.trim(),
    r.nivel_nombre || "-",
    r.turno || "-",
    r.nombre_mes || "-",
    formatMonto(r.monto_esperado),
    formatMonto(r.monto_pagado),
    formatMonto(r.monto_pendiente),
    (r.estado || "-").toUpperCase(),
    formatFecha(r.fecha_vencimiento),
  ]);

  const estadoColor = (v) => {
    if (v === "VENCIDO") return COLORS.danger;
    if (v === "PARCIAL") return COLORS.warning;
    return null;
  };

  dibujarTabla(doc, headers, tableRows, colWidths, {
    hAlign: [
      "center",
      "left",
      "left",
      "center",
      "left",
      "right",
      "right",
      "right",
      "center",
      "center",
    ],
    cAlign: [
      "center",
      "left",
      "left",
      "center",
      "left",
      "right",
      "right",
      "right",
      "center",
      "center",
    ],
    cellColor: { 8: estadoColor },
  });

  // Barra de total — solo si hay espacio (evitar páginas en blanco)
  const anchoTotal = colWidths.reduce((a, b) => a + b, 0);
  if (doc.y + 34 < doc.page.height - 70) {
    const barY = doc.y + 4;
    doc.rect(40, barY, anchoTotal, 22).fill(COLORS.primary);
    doc
      .fillColor("white")
      .fontSize(10)
      .font("Helvetica-Bold")
      .text(`TOTAL PENDIENTE: ${formatMonto(totalPendiente)}`, 44, barY + 5, {
        width: anchoTotal - 8,
        align: "right",
      });
    doc.y = barY + 26;
  }

  dibujarPiePagina(doc);
  doc.end();

  return new Promise((res, rej) => {
    stream.on("finish", () =>
      res({
        ok: true,
        rutaPDF,
        nombreArchivo,
        total: rows.length,
        totalPendiente,
        tipo: "pagos_pendientes",
      }),
    );
    stream.on("error", rej);
  });
}

// ════════════════════════════════════════════════
// REPORTE 3 — Resumen general de inscripciones
// ════════════════════════════════════════════════
async function generarResumenInscripciones({ gestion_academica }) {
  const anio = gestion_academica || new Date().getFullYear();

  const [rows] = await pool.query(
    `
    SELECT
      n.nombre AS nivel,
      COALESCE(i.turno, c.turno, 'Sin turno') AS turno,
      COUNT(i.id)                                          AS total,
      COUNT(CASE WHEN i.id_beca IS NOT NULL THEN 1 END)   AS con_beca,
      SUM(n.precio)                                        AS ingreso_bruto
    FROM inscripciones i
    JOIN nivel n   ON n.id = i.nivel_id
    LEFT JOIN curso c ON c.id = i.curso_id
    WHERE i.gestion_academica = ? AND i.estado = 'activo'
    GROUP BY n.id, n.nombre, turno
    ORDER BY n.id, turno
  `,
    [anio],
  );

  const [totRow] = await pool.query(
    `SELECT COUNT(*) AS total FROM inscripciones WHERE gestion_academica = ? AND estado = 'activo'`,
    [anio],
  );
  const total = totRow[0]?.total || 0;

  const nombreArchivo = `resumen-inscripciones-${anio}-${Date.now()}.pdf`;
  const rutaPDF = path.join(REPORTES_DIR, nombreArchivo);

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  const stream = fs.createWriteStream(rutaPDF);
  doc.pipe(stream);

  dibujarEncabezado(
    doc,
    `Resumen de Inscripciones ${anio}`,
    `Total estudiantes inscritos: ${total}`,
  );

  const headers = ["Nivel", "Turno", "Inscritos", "Con Beca", "Ingreso Bruto"];
  const colWidths = [200, 100, 80, 80, 100];

  const tableRows = rows.map((r) => [
    r.nivel,
    r.turno,
    r.total,
    r.con_beca,
    formatMonto(r.ingreso_bruto),
  ]);

  dibujarTabla(doc, headers, tableRows, colWidths, {
    cAlign: ["left", "center", "center", "center", "right"],
    hAlign: ["left", "center", "center", "center", "right"],
  });

  // Total general — solo si hay espacio
  if (doc.y + 30 < doc.page.height - 70) {
    doc.moveDown(0.4);
    doc
      .fillColor(COLORS.primary)
      .fontSize(11)
      .font("Helvetica-Bold")
      .text(`TOTAL GENERAL: ${total} estudiante(s) en la gestión ${anio}`, 40);
  }

  dibujarPiePagina(doc);
  doc.end();

  return new Promise((res, rej) => {
    stream.on("finish", () =>
      res({ ok: true, rutaPDF, nombreArchivo, total, tipo: "resumen" }),
    );
    stream.on("error", rej);
  });
}

// ════════════════════════════════════════════════
// Función principal: detectar tipo y generar
// ════════════════════════════════════════════════
async function generarReporte(pregunta) {
  const p = (pregunta || "").toLowerCase();

  // Detectar nivel desde DB
  let nivel_id = null;
  let nivel_nombre = null;
  try {
    const [niveles] = await pool.query(
      "SELECT id, nombre FROM nivel ORDER BY id",
    );
    for (const n of niveles) {
      const nLow = n.nombre.toLowerCase().replace(/\s+/g, "");
      const pLow = p.replace(/\s+/g, "");
      if (pLow.includes(nLow) || p.includes(n.nombre.toLowerCase())) {
        nivel_id = n.id;
        nivel_nombre = n.nombre;
        break;
      }
    }
    // Fallback numérico
    if (!nivel_id) {
      const mapeo = {
        primer: 1,
        primero: 1,
        "1er": 1,
        "1°": 1,
        segundo: 2,
        "2do": 2,
        "2°": 2,
        tercer: 3,
        "3er": 3,
        cuarto: 4,
        quinto: 5,
        sexto: 6,
      };
      for (const [key, id] of Object.entries(mapeo)) {
        if (p.includes(key)) {
          const n = niveles.find((x) => x.id === id);
          if (n) {
            nivel_id = n.id;
            nivel_nombre = n.nombre;
            break;
          }
        }
      }
    }
  } catch (_) {}

  // Detectar turno
  let turno = null;
  let turno_label = null;
  if (/ma[ñn]ana|mañana/.test(p)) {
    turno = "mañana";
    turno_label = "Mañana";
  } else if (/tarde/.test(p)) {
    turno = "tarde";
    turno_label = "Tarde";
  } else if (/noche/.test(p)) {
    turno = "noche";
    turno_label = "Noche";
  }

  // Detectar año
  const anioMatch = p.match(/\b(202\d)\b/);
  const gestion_academica = anioMatch
    ? parseInt(anioMatch[1])
    : new Date().getFullYear();

  const filtros = {
    nivel_id,
    nivel_nombre,
    turno,
    turno_label,
    gestion_academica,
  };

  if (
    /pago.*pendiente|pendiente.*pago|deuda|deben|moros|cobro\s+pendiente/.test(
      p,
    )
  )
    return await generarReportePagosPendientes(filtros);

  if (
    /resumen.*inscripci|total.*inscrit|cu[aá]ntos.*inscrit|resumen.*general/.test(
      p,
    )
  )
    return await generarResumenInscripciones(filtros);

  // Default → lista de estudiantes
  return await generarReporteEstudiantesPorNivel(filtros);
}

// Limpiar PDFs viejos (más de 2 horas) para no llenar disco
function limpiarPDFsViejos() {
  try {
    const now = Date.now();
    fs.readdirSync(REPORTES_DIR).forEach((f) => {
      const full = path.join(REPORTES_DIR, f);
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) fs.unlinkSync(full);
    });
  } catch (_) {}
}
setInterval(limpiarPDFsViejos, 60 * 60 * 1000); // cada hora

module.exports = {
  generarReporte,
  generarReporteEstudiantesPorNivel,
  generarReportePagosPendientes,
  generarResumenInscripciones,
  REPORTES_DIR,
};

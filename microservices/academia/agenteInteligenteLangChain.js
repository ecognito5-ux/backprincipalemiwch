// ===== AGENTE INTELIGENTE CON LANGCHAIN - PARA DIRECTOR Y SECRETARIA =====
// Implementación separada usando LangChain para consultas administrativas
// NO afecta el agente actual (agenteInteligente.js) que funciona para WhatsApp y Administradores

const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { ChatPromptTemplate, MessagesPlaceholder } = require('@langchain/core/prompts');
const { HumanMessage, AIMessage } = require('@langchain/core/messages');
const { RunnableSequence } = require('@langchain/core/runnables');
const { Document } = require('@langchain/core/documents');
const { BufferMemory } = require('langchain/memory');
const { ConversationChain } = require('langchain/chains');
const { Tool } = require('@langchain/core/tools');
const { AgentExecutor, createToolCallingAgent } = require('langchain/agents');
const pool = require('./config');
const {
  GEMINI_API_KEY,
  obtenerModelosGemini,
  esErrorRecuperableGemini
} = require('./geminiConfig');

// ===== CONFIGURACIÓN =====

// Normaliza entradas que pueden llegar como objeto desde function-calling
function normalizarTextoConsulta(consulta) {
  if (typeof consulta === 'string') return consulta;
  if (consulta == null) return '';
  if (typeof consulta === 'object') {
    const posible =
      consulta.input ??
      consulta.consulta ??
      consulta.query ??
      consulta.text ??
      consulta.pregunta ??
      null;
    if (typeof posible === 'string') return posible;
    try {
      return JSON.stringify(consulta);
    } catch (_) {
      return String(consulta);
    }
  }
  return String(consulta);
}

let llm = null;
let modeloLangChainActual = null;

function crearLlmGemini(modelo) {
  return new ChatGoogleGenerativeAI({
    apiKey: GEMINI_API_KEY,
    model: modelo,
    temperature: 0.1,
    maxOutputTokens: 2000
  });
}

// ===== HERRAMIENTAS PARA CONSULTAS ADMINISTRATIVAS =====

/**
 * Herramienta: Consultar estadísticas de inscripciones
 */
const herramientaEstadisticasInscripciones = new Tool({
  name: 'consultar_estadisticas_inscripciones',
  description: `Consulta estadísticas sobre inscripciones de estudiantes.
  Úsala cuando pregunten sobre:
  - Cuántos estudiantes se han inscrito
  - Inscripciones por nivel o curso
  - Inscripciones por año o período
  - Total de inscripciones activas`,
  func: async (consulta) => {
    try {
      // Extraer información de la consulta
      const consultaTexto = normalizarTextoConsulta(consulta);
      const consultaLower = consultaTexto.toLowerCase();
      
      // Detectar si pregunta por nivel específico
      const niveles = ['inicial', 'kinder', 'primaria', 'secundaria', 'prekinder'];
      let nivelFiltro = null;
      for (const nivel of niveles) {
        if (consultaLower.includes(nivel)) {
          nivelFiltro = nivel;
          break;
        }
      }
      
      // Detectar si pregunta por año específico
      const añoMatch = consultaTexto.match(/\b(20\d{2})\b/);
      const añoFiltro = añoMatch ? añoMatch[1] : new Date().getFullYear();
      
      let query = `
        SELECT 
          COUNT(DISTINCT i.id) as total_inscripciones,
          COUNT(DISTINCT i.estudiante_id) as total_estudiantes,
          n.nombre as nivel_nombre,
          COUNT(DISTINCT c.id) as total_cursos
        FROM inscripciones i
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        WHERE i.estado = 'activo'
      `;
      
      const params = [];
      
      if (nivelFiltro) {
        query += ` AND LOWER(n.nombre) LIKE ?`;
        params.push(`%${nivelFiltro}%`);
      }
      
      if (añoFiltro) {
        query += ` AND i.anio = ?`;
        params.push(añoFiltro);
      }
      
      query += ` GROUP BY n.id, n.nombre ORDER BY n.nombre`;
      
      const [resultados] = await pool.query(query, params);
      
      if (resultados.length === 0) {
        return 'No se encontraron inscripciones con los criterios especificados.';
      }
      
      let respuesta = `📊 **Estadísticas de Inscripciones** (Año ${añoFiltro}):\n\n`;
      
      let totalGeneral = 0;
      resultados.forEach(row => {
        respuesta += `• **${row.nivel_nombre || 'Sin nivel'}**:\n`;
        respuesta += `  - Total inscripciones: ${row.total_inscripciones}\n`;
        respuesta += `  - Total estudiantes: ${row.total_estudiantes}\n`;
        respuesta += `  - Cursos: ${row.total_cursos}\n\n`;
        totalGeneral += parseInt(row.total_inscripciones);
      });
      
      respuesta += `**Total general**: ${totalGeneral} inscripciones activas`;
      
      return respuesta;
    } catch (error) {
      console.error('Error en herramienta estadísticas:', error);
      return `Error al consultar estadísticas: ${error.message}`;
    }
  }
});

/**
 * Herramienta: Consultar información de estudiantes
 */
const herramientaConsultarEstudiantes = new Tool({
  name: 'consultar_estudiantes',
  description: `Consulta información sobre estudiantes.
  Úsala cuando pregunten sobre:
  - Lista de estudiantes
  - Estudiantes por nivel o curso
  - Información específica de un estudiante
  - Total de estudiantes activos`,
  func: async (consulta) => {
    try {
      const consultaTexto = normalizarTextoConsulta(consulta);
      const consultaLower = consultaTexto.toLowerCase();
      
      // Detectar si pregunta por nivel específico
      const niveles = ['inicial', 'kinder', 'primaria', 'secundaria'];
      let nivelFiltro = null;
      for (const nivel of niveles) {
        if (consultaLower.includes(nivel)) {
          nivelFiltro = nivel;
          break;
        }
      }
      
      // Detectar si pregunta por nombre específico
      const nombreMatch = consultaTexto.match(/(?:estudiante|alumno|alumna)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]*)*)/i);
      const nombreEstudiante = nombreMatch ? nombreMatch[1] : null;
      
      let query = `
        SELECT 
          e.id,
          e.nombre,
          e.apellido_paterno,
          e.apellido_materno,
          e.ci_estudiante,
          n.nombre as nivel_nombre,
          c.nombre as curso_nombre,
          i.anio
        FROM estudiantes e
        LEFT JOIN inscripciones i ON e.id = i.estudiante_id AND i.estado = 'activo'
        LEFT JOIN nivel n ON i.nivel_id = n.id
        LEFT JOIN curso c ON i.curso_id = c.id
        WHERE e.estado_id = 1
      `;
      
      const params = [];
      
      if (nombreEstudiante) {
        query += ` AND (e.nombre LIKE ? OR CONCAT(e.nombre, ' ', e.apellido_paterno) LIKE ?)`;
        params.push(`%${nombreEstudiante}%`, `%${nombreEstudiante}%`);
      }
      
      if (nivelFiltro) {
        query += ` AND LOWER(n.nombre) LIKE ?`;
        params.push(`%${nivelFiltro}%`);
      }
      
      query += ` ORDER BY e.nombre, e.apellido_paterno LIMIT 50`;
      
      const [resultados] = await pool.query(query, params);
      
      if (resultados.length === 0) {
        return 'No se encontraron estudiantes con los criterios especificados.';
      }
      
      if (nombreEstudiante && resultados.length === 1) {
        const est = resultados[0];
        return `📋 **Información del Estudiante**:\n\n` +
               `• **Nombre completo**: ${est.nombre} ${est.apellido_paterno || ''} ${est.apellido_materno || ''}\n` +
               `• **CI**: ${est.ci_estudiante || 'No registrado'}\n` +
               `• **Nivel**: ${est.nivel_nombre || 'Sin nivel asignado'}\n` +
               `• **Curso**: ${est.curso_nombre || 'Sin curso asignado'}\n` +
               `• **Año**: ${est.anio || 'No especificado'}`;
      }
      
      let respuesta = `📋 **Lista de Estudiantes** (${resultados.length} encontrados):\n\n`;
      
      resultados.forEach((est, idx) => {
        respuesta += `${idx + 1}. **${est.nombre} ${est.apellido_paterno || ''}**\n`;
        respuesta += `   - Nivel: ${est.nivel_nombre || 'Sin nivel'}\n`;
        respuesta += `   - Curso: ${est.curso_nombre || 'Sin curso'}\n`;
        respuesta += `   - Año: ${est.anio || 'N/A'}\n\n`;
      });
      
      if (resultados.length >= 50) {
        respuesta += `\n⚠️ Se muestran solo los primeros 50 resultados. Refina tu búsqueda para obtener resultados más específicos.`;
      }
      
      return respuesta;
    } catch (error) {
      console.error('Error en herramienta estudiantes:', error);
      return `Error al consultar estudiantes: ${error.message}`;
    }
  }
});

/**
 * Herramienta: Consultar estadísticas de pagos
 */
const herramientaEstadisticasPagos = new Tool({
  name: 'consultar_estadisticas_pagos',
  description: `Consulta estadísticas sobre pagos y compromisos económicos.
  Úsala cuando pregunten sobre:
  - Total de ingresos
  - Pagos por mes
  - Estudiantes con pagos pendientes
  - Montos recaudados`,
  func: async (consulta) => {
    try {
      const consultaTexto = normalizarTextoConsulta(consulta);
      const consultaLower = consultaTexto.toLowerCase();
      
      // Detectar si pregunta por mes específico
      const meses = ['febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
      let mesFiltro = null;
      for (const mes of meses) {
        if (consultaLower.includes(mes)) {
          mesFiltro = mes;
          break;
        }
      }
      
      // Detectar si pregunta por año
      const añoMatch = consulta.match(/\b(20\d{2})\b/);
      const añoFiltro = añoMatch ? añoMatch[1] : new Date().getFullYear();
      
      let query = `
        SELECT 
          COUNT(DISTINCT pr.id) as total_pagos,
          COALESCE(SUM(pr.monto), 0) as total_recaudado,
          COUNT(DISTINCT pr.id_compromiso) as compromisos_con_pagos,
          pm.nombre_mes,
          pm.mes
        FROM pagos_realizados pr
        LEFT JOIN pagos_mensuales pm ON pr.id_compromiso = pm.id_compromiso AND pr.mes = pm.nombre_mes
        WHERE YEAR(pr.fecha_pago) = ?
      `;
      
      const params = [añoFiltro];
      
      if (mesFiltro) {
        query += ` AND LOWER(pm.nombre_mes) = ?`;
        params.push(mesFiltro.toLowerCase());
        query += ` GROUP BY pm.mes, pm.nombre_mes`;
      } else {
        query += ` GROUP BY pm.mes, pm.nombre_mes ORDER BY pm.mes`;
      }
      
      const [resultados] = await pool.query(query, params);
      
      if (resultados.length === 0) {
        return `No se encontraron pagos registrados para el año ${añoFiltro}${mesFiltro ? ` en el mes de ${mesFiltro}` : ''}.`;
      }
      
      let respuesta = `💰 **Estadísticas de Pagos** (Año ${añoFiltro}):\n\n`;
      
      let totalGeneral = 0;
      let totalPagosGeneral = 0;
      
      resultados.forEach(row => {
        const mesNombre = row.nombre_mes || 'Sin especificar';
        const totalMes = parseFloat(row.total_recaudado) || 0;
        totalGeneral += totalMes;
        totalPagosGeneral += parseInt(row.total_pagos) || 0;
        
        respuesta += `• **${mesNombre.charAt(0).toUpperCase() + mesNombre.slice(1)}**:\n`;
        respuesta += `  - Total recaudado: Bs. ${totalMes.toFixed(2)}\n`;
        respuesta += `  - Número de pagos: ${row.total_pagos}\n\n`;
      });
      
      respuesta += `**Total general**:\n`;
      respuesta += `- Total recaudado: Bs. ${totalGeneral.toFixed(2)}\n`;
      respuesta += `- Total de pagos: ${totalPagosGeneral}`;
      
      return respuesta;
    } catch (error) {
      console.error('Error en herramienta pagos:', error);
      return `Error al consultar estadísticas de pagos: ${error.message}`;
    }
  }
});

/**
 * Herramienta: Consultar estudiantes con pagos pendientes
 */
const herramientaPagosPendientes = new Tool({
  name: 'consultar_pagos_pendientes',
  description: `Consulta información sobre estudiantes con pagos pendientes o vencidos.
  Úsala cuando pregunten sobre:
  - Estudiantes que deben pagar
  - Cuotas vencidas
  - Deudas pendientes`,
  func: async (consulta) => {
    try {
      const consultaTexto = normalizarTextoConsulta(consulta);
      const consultaLower = consultaTexto.toLowerCase();
      
      // Detectar si pregunta por mes específico
      const meses = ['febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
      let mesFiltro = null;
      for (const mes of meses) {
        if (consultaLower.includes(mes)) {
          mesFiltro = mes;
          break;
        }
      }
      
      let query = `
        SELECT 
          e.id,
          e.nombre,
          e.apellido_paterno,
          e.apellido_materno,
          pm.nombre_mes,
          pm.monto_esperado,
          COALESCE(SUM(pr.monto), 0) as monto_pagado,
          (pm.monto_esperado - COALESCE(SUM(pr.monto), 0)) as monto_pendiente,
          pm.estado,
          pm.fecha_vencimiento
        FROM estudiantes e
        INNER JOIN compromiso_economico ce ON e.id = ce.id_estudiante
        INNER JOIN pagos_mensuales pm ON ce.id = pm.id_compromiso
        LEFT JOIN pagos_realizados pr ON ce.id = pr.id_compromiso AND pr.mes = pm.nombre_mes
        WHERE pm.estado IN ('pendiente', 'parcial', 'vencido')
      `;
      
      const params = [];
      
      if (mesFiltro) {
        query += ` AND LOWER(pm.nombre_mes) = ?`;
        params.push(mesFiltro.toLowerCase());
      }
      
      query += ` 
        GROUP BY e.id, e.nombre, e.apellido_paterno, e.apellido_materno, pm.id, pm.nombre_mes, pm.monto_esperado, pm.estado, pm.fecha_vencimiento
        HAVING monto_pendiente > 0
        ORDER BY pm.fecha_vencimiento ASC, e.nombre
        LIMIT 50
      `;
      
      const [resultados] = await pool.query(query, params);
      
      if (resultados.length === 0) {
        return `No se encontraron estudiantes con pagos pendientes${mesFiltro ? ` para el mes de ${mesFiltro}` : ''}.`;
      }
      
      let respuesta = `⚠️ **Estudiantes con Pagos Pendientes** (${resultados.length} encontrados):\n\n`;
      
      let totalPendiente = 0;
      
      resultados.forEach((row, idx) => {
        const montoPendiente = parseFloat(row.monto_pendiente) || 0;
        totalPendiente += montoPendiente;
        
        respuesta += `${idx + 1}. **${row.nombre} ${row.apellido_paterno || ''}**\n`;
        respuesta += `   - Mes: ${row.nombre_mes}\n`;
        respuesta += `   - Monto esperado: Bs. ${parseFloat(row.monto_esperado || 0).toFixed(2)}\n`;
        respuesta += `   - Monto pagado: Bs. ${parseFloat(row.monto_pagado || 0).toFixed(2)}\n`;
        respuesta += `   - Monto pendiente: Bs. ${montoPendiente.toFixed(2)}\n`;
        respuesta += `   - Estado: ${row.estado}\n`;
        if (row.fecha_vencimiento) {
          respuesta += `   - Vence: ${new Date(row.fecha_vencimiento).toLocaleDateString('es-BO')}\n`;
        }
        respuesta += `\n`;
      });
      
      respuesta += `**Total pendiente**: Bs. ${totalPendiente.toFixed(2)}`;
      
      if (resultados.length >= 50) {
        respuesta += `\n\n⚠️ Se muestran solo los primeros 50 resultados.`;
      }
      
      return respuesta;
    } catch (error) {
      console.error('Error en herramienta pagos pendientes:', error);
      return `Error al consultar pagos pendientes: ${error.message}`;
    }
  }
});

/**
 * Herramienta: Generar documento de asistencia (PDF o Word)
 */
const herramientaGenerarDocumentoAsistencia = new Tool({
  name: 'generar_documento_asistencia',
  description: `Genera un documento (PDF o Word) con lista de estudiantes para marcar asistencia.
  Úsala cuando pregunten sobre:
  - Generar lista de asistencia
  - Crear documento para marcar asistencia
  - Lista de estudiantes para asistencia
  - Imprimir lista de asistencia
  
  Parámetros esperados en la consulta:
  - nivel: nombre del nivel (ej: "primer nivel", "primaria")
  - turno: turno (ej: "mañana", "tarde")
  - formato: "pdf" o "word" (por defecto PDF)
  - año: año académico (opcional, por defecto año actual)`,
  func: async (consulta) => {
    try {
      const consultaTexto = normalizarTextoConsulta(consulta);
      const consultaLower = consultaTexto.toLowerCase();
      
      // Detectar nivel
      const niveles = ['primer nivel', 'segundo nivel', 'tercer nivel', 'cuarto nivel', 'quinto nivel', 
                       'sexto nivel', 'séptimo nivel', 'octavo nivel', 'inicial', 'kinder', 'primaria', 'secundaria'];
      let nivelDetectado = null;
      for (const nivel of niveles) {
        if (consultaLower.includes(nivel)) {
          nivelDetectado = nivel;
          break;
        }
      }
      
      // Detectar turno
      const turnos = ['mañana', 'tarde', 'noche', 'manana'];
      let turnoDetectado = null;
      for (const turno of turnos) {
        if (consultaLower.includes(turno)) {
          turnoDetectado = turno === 'manana' ? 'mañana' : turno;
          break;
        }
      }
      
      // Detectar formato
      const formatoPDF = consultaLower.includes('pdf') || consultaLower.includes('pdf');
      const formatoWord = consultaLower.includes('word') || consultaLower.includes('docx') || consultaLower.includes('doc');
      const formato = formatoWord ? 'word' : 'pdf'; // Por defecto PDF
      
      // Detectar año
      const añoMatch = consultaTexto.match(/\b(20\d{2})\b/);
      const añoDetectado = añoMatch ? añoMatch[1] : null;
      
      if (!nivelDetectado) {
        return 'Error: No se pudo detectar el nivel. Por favor, especifica el nivel (ej: "primer nivel", "primaria").';
      }
      
      // Importar servicio de documentos
      const documentosAsistenciaService = require('./documentosAsistenciaService');
      
      let resultado;
      if (formato === 'word') {
        resultado = await documentosAsistenciaService.generarWordAsistencia(
          nivelDetectado,
          turnoDetectado,
          añoDetectado ? parseInt(añoDetectado) : null
        );
      } else {
        resultado = await documentosAsistenciaService.generarPDFAsistencia(
          nivelDetectado,
          turnoDetectado,
          añoDetectado ? parseInt(añoDetectado) : null
        );
      }
      
      // Guardar params para que el frontend muestre botón de descarga
      lastDocumentoAsistencia = {
        nivel: resultado.nivel || nivelDetectado,
        turno: resultado.turno || turnoDetectado,
        formato: formato,
        anio: resultado.año
      };
      
       // Retornar información del documento generado con instrucciones de descarga
       return `✅ **Documento de asistencia generado exitosamente**
 
 📄 **Detalles del documento:**
 • Formato: ${formato.toUpperCase()}
 • Nivel: ${resultado.nivel || 'Todos'}
 • Turno: ${resultado.turno || 'Todos'}
 • Año: ${resultado.anio}

 El documento está listo para ser descargado desde el panel.`;
    } catch (error) {
      console.error('Error en herramienta generar documento asistencia:', error);
      return `Error al generar documento de asistencia: ${error.message}`;
    }
  }

  }
});

// Último documento de asistencia generado (para que el frontend ofrezca descarga)
let lastDocumentoAsistencia = null;

// Lista de herramientas disponibles
const herramientas = [
  herramientaEstadisticasInscripciones,
  herramientaConsultarEstudiantes,
  herramientaEstadisticasPagos,
  herramientaPagosPendientes,
  herramientaGenerarDocumentoAsistencia
];

// ===== PROMPT DEL AGENTE =====

const promptAgente = ChatPromptTemplate.fromMessages([
  ['system', `Eres un asistente inteligente especializado en consultas administrativas para una unidad educativa.
  
Tu rol es ayudar a Directores y Secretarias a obtener información sobre:
- Estadísticas de inscripciones y estudiantes
- Información de pagos y compromisos económicos
- Listas de estudiantes y sus datos
- Reportes administrativos
- Generar documentos (listas de asistencia en PDF o Word)

INSTRUCCIONES:
1. Usa las herramientas disponibles para obtener información precisa de la base de datos
2. Responde de forma clara y estructurada
3. Si no tienes información suficiente, indica qué necesitas para ayudar mejor
4. Sé profesional y conciso
5. Formatea las respuestas de manera legible con emojis cuando sea apropiado

CONTEXTO DEL USUARIO:
- Rol: {rol}
- Nombre: {nombre_usuario}

Responde en español boliviano.`],
  new MessagesPlaceholder('chat_history'),
  ['human', '{input}'],
  new MessagesPlaceholder('agent_scratchpad')
]);

// ===== CREAR AGENTE CON LANGCHAIN =====

let agenteEjecutor = null;

async function inicializarAgenteLangChain(modeloForzado = null) {
  try {
    const modelos = modeloForzado ? [modeloForzado] : await obtenerModelosGemini();
    const modelo = modelos[0];
    if (!modelo) {
      throw new Error('No hay modelos Gemini disponibles para LangChain.');
    }

    llm = crearLlmGemini(modelo);
    modeloLangChainActual = modelo;
    console.log(`🔄 [LangChain] Inicializando agente con modelo ${modelo}...`);
    
    // Validar herramientas: evita crash en AgentExecutor (t.name.toLowerCase())
    const herramientasNormalizadas = (Array.isArray(herramientas) ? herramientas : [])
      .filter(Boolean)
      .map((t, idx) => {
        const nombre =
          (typeof t?.name === 'string' && t.name) ||
          (typeof t?.lc_kwargs?.name === 'string' && t.lc_kwargs.name) ||
          (typeof t?.fields?.name === 'string' && t.fields.name) ||
          '';
        if (!nombre) {
          throw new Error(`Herramienta sin nombre en índice ${idx}. Verifica su definición.`);
        }
        // LangChain (AgentExecutor) usa t.name directamente; asegúralo aunque el Tool lo guarde en lc_kwargs/fields
        if (typeof t.name !== 'string' || !t.name) {
          t.name = nombre;
        }
        return t;
      });
    
    // Crear agente con tool calling (compatible con Gemini)
    const agent = createToolCallingAgent({
      llm: llm,
      tools: herramientasNormalizadas,
      prompt: promptAgente
    });
    
    // Crear ejecutor del agente
    agenteEjecutor = new AgentExecutor({
      agent: agent,
      tools: herramientasNormalizadas,
      verbose: false, // Cambiar a true para debugging
      maxIterations: 5
    });
    
    console.log('✅ [LangChain] Agente inicializado correctamente');
    return true;
  } catch (error) {
    console.error('❌ [LangChain] Error al inicializar agente:', error);
    return false;
  }
}

// ===== FUNCIÓN PRINCIPAL PARA EJECUTAR CONSULTAS =====

/**
 * Ejecuta una consulta usando el agente LangChain
 * @param {string} pregunta - La pregunta del usuario
 * @param {Object} infoUsuario - Información del usuario (rol, nombre, etc.)
 * @param {Array} historialConversacion - Historial de mensajes anteriores
 * @returns {Promise<Object>} Respuesta con texto, herramientas usadas, etc.
 */
async function ejecutarAgenteLangChain(pregunta, infoUsuario = null, historialConversacion = []) {
  const modelos = await obtenerModelosGemini();
  let ultimoError = null;

  for (const modelo of modelos) {
    try {
      if (!agenteEjecutor || modeloLangChainActual !== modelo) {
        agenteEjecutor = null;
        const inicializado = await inicializarAgenteLangChain(modelo);
        if (!inicializado) {
          continue;
        }
      }

      const input = typeof pregunta === 'string' ? pregunta.trim() : String(pregunta ?? '');
      if (!input) {
        throw new Error('La pregunta no puede estar vacía');
      }

      const rol = (infoUsuario?.rol && String(infoUsuario.rol)) || 'Usuario';
      const nombreUsuario = (infoUsuario?.nombre && String(infoUsuario.nombre)) || 'Usuario';

      const chatHistory = (Array.isArray(historialConversacion) ? historialConversacion : []).map((msg) => {
        const contenido = String(msg.mensaje ?? msg.contenido ?? '').trim() || ' ';
        if ((msg.rol || msg.tipo) === 'usuario') {
          return new HumanMessage(contenido);
        }
        return new AIMessage(contenido);
      });

      const inicioTiempo = Date.now();

      const resultado = await agenteEjecutor.invoke({
        input,
        rol,
        nombre_usuario: nombreUsuario,
        chat_history: chatHistory
      });

      const tiempoRespuesta = Date.now() - inicioTiempo;
      const respuesta = resultado.output || resultado.text || 'No se pudo generar una respuesta.';
      const steps = resultado.intermediateSteps || resultado.intermediate_steps || [];
      const herramientasUsadas = steps
        .map(
          (step) =>
            (step.action && step.action.tool) ||
            (Array.isArray(step) && step[0] && step[0].tool) ||
            step.tool
        )
        .filter(Boolean);
      const usóGenerarAsistencia =
        Array.isArray(herramientasUsadas) &&
        herramientasUsadas.some((t) => t === 'generar_documento_asistencia');
      const hayDocumentoParaDescarga =
        (usóGenerarAsistencia || lastDocumentoAsistencia) && lastDocumentoAsistencia;

      const out = {
        respuesta,
        herramienta: herramientasUsadas.length > 0 ? herramientasUsadas.join(', ') : 'langchain_agent',
        clasificacion: 'administrativa',
        tiempo_ms: tiempoRespuesta,
        herramientas_usadas: herramientasUsadas,
        modelo_gemini: modelo
      };
      if (hayDocumentoParaDescarga) {
        out.documentoAsistencia = { ...lastDocumentoAsistencia };
        lastDocumentoAsistencia = null;
      }
      return out;
    } catch (error) {
      ultimoError = error;
      if (esErrorRecuperableGemini(error)) {
        console.warn(`⚠️ [LangChain] Modelo ${modelo} falló, probando siguiente...`, error.message);
        agenteEjecutor = null;
        continue;
      }
      break;
    }
  }

  const error = ultimoError || new Error('No se pudo conectar con ningún modelo Gemini.');
  console.error('❌ [LangChain] Error al ejecutar agente:', error);

  return {
    respuesta: `Lo siento, hubo un error al procesar tu consulta: ${error.message}. Por favor, intenta reformular tu pregunta o contacta con el administrador del sistema.`,
    herramienta: 'error',
    clasificacion: 'error',
    tiempo_ms: 0,
    herramientas_usadas: []
  };
}

// ===== EXPORTAR FUNCIONES =====

module.exports = {
  ejecutarAgenteLangChain,
  inicializarAgenteLangChain
};

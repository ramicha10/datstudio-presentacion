require('dotenv').config();
const { ORACLE_INTERPRETER_SYSTEM } = require('./oracle_system');
const { BUSINESS_AGENTS, BUSINESS_SKILL_CONTEXT } = require('./business_system');
// pdf-parse removed — using pdfjs-dist directly (avoids DOMMatrix crash in serverless)
const mammoth = require('mammoth');
const Tesseract = require('tesseract.js');
const express    = require('express');
const session    = require('express-session');
const passport   = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { Pool }   = require('pg');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || null;

// ─── Validaciones ─────────────────────────────────────────────────────────────
const REQUIRED = ['ANTHROPIC_API_KEY','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','SESSION_SECRET','SOTER_DB_URL','POSEIDON_DB_URL','HERMES_DB_URL'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) { console.error('Faltan variables en .env:', missing.join(', ')); process.exit(1); }

// ─── Pools de BD ──────────────────────────────────────────────────────────────
const soter    = new Pool({ connectionString: process.env.SOTER_DB_URL,    ssl: { rejectUnauthorized: false } });
const poseidon = new Pool({ connectionString: process.env.POSEIDON_DB_URL, ssl: { rejectUnauthorized: false } });
const hermes   = new Pool({ connectionString: process.env.HERMES_DB_URL,   ssl: { rejectUnauthorized: false } });

// ─── Google OAuth ─────────────────────────────────────────────────────────────
passport.use(new GoogleStrategy({
  clientID:     process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL:  process.env.BASE_URL
    ? `${process.env.BASE_URL}/auth/google/callback`
    : `http://localhost:${PORT}/auth/google/callback`
}, (accessToken, refreshToken, profile, done) => {
  const email = profile.emails?.[0]?.value || '';
  if (ALLOWED_DOMAIN && !email.endsWith('@' + ALLOWED_DOMAIN)) {
    return done(null, false);
  }
  return done(null, { id: profile.id, name: profile.displayName, email, avatar: profile.photos?.[0]?.value || null, accessToken });
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autenticado' });
  res.redirect('/login');
}

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/gmail.readonly'],
  accessType: 'online'
}));
app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=1' }),
  (req, res) => res.redirect('/')
);
app.get('/logout', (req, res) => req.logout(() => res.redirect('/login')));
app.get('/acceso-directo', (req, res) => {
  const token = req.query.token;
  if (!token || token !== process.env.BYPASS_TOKEN) return res.redirect('/login');
  req.login({ id: 'bypass', name: 'Ramiro Chami', email: 'ramiro.chami@premiar.seg.ar', avatar: null, accessToken: null }, (err) => {
    if (err) return res.redirect('/login');
    res.redirect('/');
  });
});
app.get('/api/me', requireAuth, (req, res) => {
  const { name, email, avatar } = req.user;
  res.json({ name, email, avatar });
});

// ─── Helper: llamar a Claude ──────────────────────────────────────────────────
async function callClaude(system, messages, maxTokens = 1000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, system, messages })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Error API');
  return data.content?.find(b => b.type === 'text')?.text || '';
}

// ─── ORACLE — Sistema inteligente con 3 BDs ───────────────────────────────────

const QUERY_ROUTER_SYSTEM = `Sos un experto en las bases de datos de Premiar Caucion Argentina. Tu tarea es generar las queries SQL necesarias para responder la pregunta del usuario.

== BASES DE DATOS ==
1. SOTER: polizas, tomadores, productores, ejecutivos, siniestros
2. POSEIDON: facturacion, cobranzas, deuda
3. HERMES: emails ingresados, tareas

== ESTRUCTURA SOTER ==

TABLA policies:
  id, policy_number, taker_name, taker_id, insured_name, insured_id,
  producer_name, producer_id, executive_id, risk_id,
  sum_assured, taxable_base, prize, rate,
  vality_from, vality_until, state, canceled_at, date_of_emission,
  endorsement_type_id, sequence_number

TABLA endorsement_types:
  id, name, billing_document_type_id
  billing_document_type_id = 1 → Factura (SUMA produccion)
  billing_document_type_id = 2 → Nota de Credito (RESTA produccion)
  billing_document_type_id = 3 → Sin comprobante (NO afecta produccion)

ENDOSOS CLAVE:
  id=1  Poliza Nueva → Factura (suma)
  id=2  Renovacion → Factura (suma)
  id=4  Rehabilitacion → Factura (suma)
  id=20 Modificaciones Varias Debitos → Factura (suma)
  id=29 Refacturacion → Factura (suma)
  id=30 Lote Refacturacion → Factura (suma)
  id=44 Reversion Debitos → Nota Credito (resta)
  id=60 Modificaciones Varias Creditos → Nota Credito (resta)
  id=65 Anulacion a Prorrata → Nota Credito (resta)
  id=69 Anulacion de Inicio → Nota Credito (resta)
  id=104 Anulacion Refacturacion → Nota Credito (resta)
  id=106 Riesgo Concluido → Sin comprobante (no afecta)

PRODUCCION NETA = SUM(CASE WHEN et.billing_document_type_id = 1 THEN p.taxable_base
                            WHEN et.billing_document_type_id = 2 THEN -p.taxable_base
                            ELSE 0 END)
SIEMPRE hacer JOIN con endorsement_types y filtrar billing_document_type_id IN (1,2)
NUNCA usar solo endorsement_type_id = 1 para calcular produccion

ESTADOS ACTIVOS: state IN ('approved','verified','billed','open') AND canceled_at IS NULL

EJECUTIVOS: executive_id → JOIN people per ON p.executive_id = per.id
  Nombre: per.first_name || ' ' || per.last_name

PRODUCTORES: producer_id → JOIN people prod ON p.producer_id = prod.id

RAMOS: risk_id → JOIN risks r ON p.risk_id = r.id → r.name
CATALOGO COMPLETO DE RAMOS (risk_id → nombre en Soter):
Obra Publica: 1=Obra Publica, 2=Obra Publica-Mant.Oferta, 3=Obra Publica Ejecucion de Contrato, 4=Obra Publica-Fondo de Reparo, 5=Obra Publica-Ant.por Acopio, 6=Obra Publica-Anticipo Financiero, 7=Obra Publica-Impugnacion, 8=Obras Privadas, 9=Obra Privada-Mant.Oferta, 10=Obra Privada-Ejecucion de Contrato, 11=Obra Privada-Fondo de Reparo, 12=Obra Privada-Ant.por Acopio, 13=Obra Privada-Anticipo Financiero, 270=Obra Privada-Impugnacion
Suministros/Servicios Publicos: 14=Suministro y/o Servicios Publicos, 15=Sum/Serv.Pub-Mant.Oferta, 16=Sum/Serv.Pub-Ejec.Contrato, 17=Sum/Serv.Pub-Fondo de Reparo, 18=Sum/Serv.Pub-Anticipo, 19=Sum/Serv.Pub-Certif.Avce.Fabric.Taller, 20=Sum/Serv.Pub-Tenencia Uso/Reparac/Manut., 21=Sum/Serv.Pub-Tenencia Material, 22=Sum/Serv.Pub-Impugnacion
Suministros/Servicios Privados: 23=Suministro y/o Servicios Privados, 24=Sum/Serv.Priv-Mant.Oferta, 25=Sum/Serv.Priv-Adjudicacion, 26=Sum/Serv.Priv-Fondo de Reparo, 27=Sum/Serv.Priv-Anticipo, 28=Sum/Serv.Priv-Certific.Avance, 29=Sum/Serv.Priv-Tenencia Uso/Reparac/Mant., 30=Sum/Serv.Priv-Tenencia Material
Aduaneras: 31=Garantias Aduaneras, 32=Aduana-TRAN, 33=Aduana-IMTE, 34=Aduana-FCEO, 35=Aduana-Habilitacion Deposito Fiscal, 36=Aduana-ANBE, 37=Aduana-Diferencia de Derechos, 39=Aduana-INHI, 40=Aduana-SUCO, 41=Aduana-DUMP, 42=Aduana-ENES, 43=Aduana-EXTE, 44=Aduana-REAU, 45=Aduana-Aduana Domiciliaria, 46=Aduana-AUTO, 77=Aduana-GPIN, 120=Aduana-VACR
Alquileres: 53=Alq.Inmuebles-Destino comercial, 54=Alq.Inmuebles-Destino vivienda, 56=Alq.Muebles-Fiador Solidario, 141=Alquileres, 268=Alq.Inmuebles-Destino vivienda (nueva ley)
Judiciales: 65=Judiciales-Contracautela, 66=Judiciales-Sustitucion Medidas Cautelares, 129=Judiciales-Sustitucion de Pago Previo, 143=Judiciales, 309=Judiciales-Sustitucion de Arraigo
Concesiones: 61=Concesiones-Pago de Canon, 68=Concesiones-Mant.Oferta, 69=Concesiones-Cumplimiento, 70=Garantias de Concesiones
IGJ/Directores: 59=IGJ, 266=IGJ Extranjeros, 272=Garantias de Directores, 311=IGJ-PCIA.DE BS.AS, 271=IGJ-SAN LUIS, 275=IGJ-TIERRA DEL FUEGO
Actividad/Profesion: 142=Actividad y/o profesion, 60=Act./Prof.-Turismo, 62=Act./Prof.-Martilleros, 63=Act./Prof.-Corredores, 90=Act./Prof.-Agencias de Personal Eventual, 133=Act./Prof.-Operadores financieros, 136=Act./Prof.-Servicios Aereos
Especiales: 102=Fiel Cumplimiento-A Favor del Financista, 127=Propiedad Horizontal, 312=Contractuales, 139=Caucion, 276=Biotecnologia-Devolucion Anticipada de IVA, 126=Energias Renovables-Devolucion Anticipada de IVA

SINONIMOS DE RAMOS (como lo dice el usuario → risk_id a usar en WHERE):
- "Contractuales" o "Contractual" → risk_id = 312
- "Alquiler" o "Alquileres" → risk_id IN (53,54,56,141,268)
- "Obra Publica" → risk_id IN (1,2,3,4,5,6,7)
- "Obra Privada" → risk_id IN (8,9,10,11,12,13,270)
- "Suministro Publico" o "Sum/Serv Pub" → risk_id IN (14,15,16,17,18,19,20,21,22)
- "Suministro Privado" o "Sum/Serv Priv" → risk_id IN (23,24,25,26,27,28,29,30)
- "Aduana" o "Aduanera" → risk_id IN (31,32,33,34,35,36,37,39,40,41,42,43,44,45,46,77,120)
- "Judicial" o "Judiciales" → risk_id IN (65,66,129,143,309)
- "Concesiones" → risk_id IN (61,68,69,70)
- "IGJ" → risk_id IN (59,266,272,311,271,275)
- "Actividad" o "Profesion" → risk_id IN (60,62,63,90,133,136,142)
- "Mantenimiento de Oferta" o "Mant Oferta" → risk_id IN (2,9,15,24,68)
- "Cumplimiento" o "Ejecucion de Contrato" → risk_id IN (3,10,16,25,69)
- "Fondo de Reparo" → risk_id IN (4,11,17,26)
- "Anticipo" → risk_id IN (5,6,12,13,18,27)

POLIZA MADRE (solo emision original): endorsement_type_id = 1 AND sequence_number = 0

== QUERY TIPO PRODUCCION POR EJECUTIVO ==
SELECT per.first_name || ' ' || per.last_name as ejecutivo,
  SUM(CASE WHEN et.billing_document_type_id = 1 THEN p.taxable_base
           WHEN et.billing_document_type_id = 2 THEN -p.taxable_base
           ELSE 0 END) as produccion_neta,
  COUNT(*) as movimientos
FROM policies p
JOIN people per ON p.executive_id = per.id
JOIN endorsement_types et ON p.endorsement_type_id = et.id
WHERE p.state IN ('approved','verified','billed','open')
AND p.canceled_at IS NULL
AND et.billing_document_type_id IN (1,2)
AND EXTRACT(year FROM p.date_of_emission) = 2026
AND EXTRACT(month FROM p.date_of_emission) IN (1,2)
GROUP BY per.first_name, per.last_name
ORDER BY produccion_neta DESC LIMIT 20

== ESTRUCTURA POSEIDON ==
- comprobantes: id, cliente_id, type, fecha, importe, numero, fechavto, letra
  (letra: FA=factura, NC=nota credito, ND=nota debito)
- comprobante_debts: id, comprobante_id, debt, date_on, is_judicial
- clientes: id, name, document_number (CUIT)

== ESTRUCTURA HERMES ==
Sistema de workflow/kanban de Premiar. Gestiona pedidos, emails y tareas por columnas.

TABLA tasks:
  id, name (titulo), list_id, created_by, assigned_to,
  date_on, date_due, archived (false=activa, true=cerrada),
  email_summary, email_content, relation_entity (jsonb),
  anging (dias de antiguedad), emails_count, rule_id

TABLA lists: id, name (nombre de columna), board_id
TABLA boards: id, name

MAPA DE LISTAS CLAVE (list_id → columna):
  BOARD 1 (principal): 3=Pedidos, 371=Cotizaciones, 372=Aprobados suscripción,
    2=Análisis suscripción, 4=Operaciones, 5=Pólizas a aprobar,
    438=Pólizas enviadas, 369=Pólizas aprobadas, 439=Viendo con sistemas,
    370=Negocio sin emitir, 471=Pólizas enviadas con excepción
  BOARD 2: 72=CONSULTA RESUELTA, 39=PEDIDOS
  BOARD 34: 303=PARA EMITIR, 307=TAREAS, 305=PEDIMOS CUPO/DATO,
    336=EMISION FRENADA, 304=VERIFICAR, 1=POLIZA ENVIADA
  BOARD 67: 171=soporte, 405=haciendo, 406=Terminado

TABLA ingested_emails:
  id, subject, from_email, from_name, body_text, status,
  task_id (FK→tasks), ai_analysis (jsonb), email_date, created_at

TABLA versions (CRITICO — historial de movimientos entre columnas):
  id, item_type ('Task'), item_id (FK→tasks.id), event ('create'/'update'),
  whodunnit (usuario), object_changes (YAML con los cambios), created_at

MOVIMIENTOS ENTRE COLUMNAS — SIEMPRE usar versions, nunca tasks:
'cuantas tarjetas pasaron de X a Y', 'volvieron de X a Y', 'se movieron de X a Y'
→ SELECT COUNT(*) FROM versions
  WHERE item_type = 'Task' AND event = 'update'
  AND object_changes ~ 'list_id:\n- {id_origen}\n- {id_destino}\n'
  AND created_at >= '{fecha_inicio}' AND created_at < '{fecha_fin}'

Ejemplo — Operaciones(4) a Pedidos(3) en marzo 2026:
  SELECT COUNT(*) FROM versions
  WHERE item_type = 'Task' AND event = 'update'
  AND object_changes ~ 'list_id:\n- 4\n- 3\n'
  AND created_at >= '2026-03-01' AND created_at < '2026-04-01'

REGLAS HERMES:
- Tareas activas: archived = false
- Tareas cerradas: archived = true
- Para nombre de columna: JOIN lists l ON t.list_id = l.id
- Movimientos: SIEMPRE usar versions con regex ~, NUNCA tasks
- Siempre LIMIT 100

REGLAS CRITICAS:

CONSULTAS COMBINADAS — cuando el usuario pide varios datos juntos, combinarlos en UNA sola query con subqueries:
Ejemplo "cuantas polizas se emitieron en marzo y el monto de refa":
SELECT
  (SELECT COUNT(*) FROM policies WHERE endorsement_type_id=1 AND sequence_number=0 AND EXTRACT(year FROM date_of_emission)=2026 AND EXTRACT(month FROM date_of_emission)=3) as polizas_emitidas,
  (SELECT COUNT(*) FROM policies WHERE endorsement_type_id=30 AND EXTRACT(year FROM date_of_emission)=2026 AND EXTRACT(month FROM date_of_emission)=3) as cantidad_refas,
  (SELECT SUM(taxable_base * COALESCE(currency_value,1)) FROM policies WHERE endorsement_type_id=30 AND EXTRACT(year FROM date_of_emission)=2026 AND EXTRACT(month FROM date_of_emission)=3) as refa_bi_pesos

CANTIDAD DE POLIZAS NUEVAS:
"cuantas polizas", "polizas emitidas", "nuevas polizas" → SOLO:
  WHERE endorsement_type_id = 1 AND sequence_number = 0

REFACTURACION (REFA):
"refa de [mes]", "refacturacion", "lote de refa" → SOLO endorsement_type_id = 30
Base Imponible en pesos (con conversion TC): SUM(p.taxable_base * COALESCE(p.currency_value, 1))
Base Imponible en moneda original: SUM(p.taxable_base)
SIEMPRE usar la conversion a pesos salvo que el usuario pida explicitamente "en moneda original".
NO usar id=29 salvo que pidan refa manual.

PRODUCCION NETA:
"produccion de [mes]", "cuanto se produjo", "base imponible", "produccion por ejecutivo/productor" →
JOIN endorsement_types et ON p.endorsement_type_id = et.id
WHERE et.billing_document_type_id IN (1,2)
SIEMPRE usar: taxable_base * COALESCE(currency_value, 1) para convertir a pesos.
SUM(CASE WHEN et.billing_document_type_id=1 THEN p.taxable_base * COALESCE(p.currency_value,1)
         WHEN et.billing_document_type_id=2 THEN -p.taxable_base * COALESCE(p.currency_value,1)
         ELSE 0 END) as produccion_neta_pesos

REGLA UNIVERSAL DE MONEDA:
SIEMPRE multiplicar taxable_base * COALESCE(currency_value, 1) para obtener el valor en pesos.
Aplica a: produccion, refa, cualquier medicion de base imponible.
NUNCA usar taxable_base solo cuando se pide un monto en pesos.

POLIZAS VIGENTES HOY:
"polizas activas", "cartera vigente" → endorsement_type_id=1 AND sequence_number=0 AND state IN ('approved','verified','billed','open') AND canceled_at IS NULL AND vality_until >= NOW()

SINONIMOS DE RAMOS — cuando el usuario mencione un ramo, usar el risk_id correspondiente con WHERE p.risk_id IN (...):
- "Contractuales" → risk_id = 312
- "Alquiler/Alquileres" → risk_id IN (53,54,56,141,268)
- "Obra Publica" → risk_id IN (1,2,3,4,5,6,7)
- "Obra Privada" → risk_id IN (8,9,10,11,12,13,270)
- "Suministro/Servicios Publico" → risk_id IN (14,15,16,17,18,19,20,21,22)
- "Suministro/Servicios Privado" → risk_id IN (23,24,25,26,27,28,29,30)
- "Aduana/Aduanera" → risk_id IN (31,32,33,34,35,36,37,39,40,41,42,43,44,45,46,77,120)
- "Judicial/Judiciales" → risk_id IN (65,66,129,143,309)
- "Concesiones" → risk_id IN (61,68,69,70)
- "IGJ" → risk_id IN (59,266,272,311,271,275)
- "Actividad/Profesion" → risk_id IN (60,62,63,90,133,136,142)
- "Mantenimiento de Oferta" → risk_id IN (2,9,15,24,68)
- "Cumplimiento/Ejecucion de Contrato" → risk_id IN (3,10,16,25,69)
- "Fondo de Reparo" → risk_id IN (4,11,17,26)
- "Anticipo" → risk_id IN (5,6,12,13,18,27)

NUNCA filtres por r.name con LIKE para buscar ramos — siempre usa risk_id IN (...) segun la tabla de arriba.

Devuelve SOLO un JSON sin texto adicional:
{"soter_sql": "..." o null, "poseidon_sql": "..." o null, "hermes_sql": "..." o null}
Si la pregunta es conceptual: {"soter_sql":null,"poseidon_sql":null,"hermes_sql":null}`;

// ORACLE_INTERPRETER_SYSTEM cargado desde oracle_system.js

app.post('/api/oracle', requireAuth, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Falta messages[]' });

  const userMsg = messages[messages.length - 1]?.content || '';
  const results = {};

  try {
    // Paso 1: determinar qué queries ejecutar
    const routerOut = await callClaude(QUERY_ROUTER_SYSTEM, [{ role: 'user', content: userMsg }], 600);
    let queries = {};
    try {
      const jsonMatch = routerOut.match(/\{[\s\S]*\}/);
      queries = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    } catch(e) { queries = {}; }

    console.log('Queries generadas:', queries);

    // Paso 2: ejecutar en paralelo las BDs necesarias
    const promises = [];
    if (queries.soter_sql) {
      promises.push(
        soter.query(queries.soter_sql)
          .then(r => { results.soter = r.rows; })
          .catch(e => { results.soter_error = e.message; console.error('Soter error:', e.message); })
      );
    }
    if (queries.poseidon_sql) {
      promises.push(
        poseidon.query(queries.poseidon_sql)
          .then(r => { results.poseidon = r.rows; })
          .catch(e => { results.poseidon_error = e.message; console.error('Poseidon error:', e.message); })
      );
    }
    if (queries.hermes_sql) {
      promises.push(
        hermes.query(queries.hermes_sql)
          .then(r => { results.hermes = r.rows; })
          .catch(e => { results.hermes_error = e.message; console.error('Hermes error:', e.message); })
      );
    }
    await Promise.all(promises);

  } catch(err) {
    console.error('Error generando queries:', err.message);
    results.error = err.message;
  }

  // Paso 3: Claude interpreta los datos reales
  let context = `PREGUNTA: ${userMsg}\n\n`;
  if (results.soter?.length)      context += `DATOS SOTER (polizas):\n${JSON.stringify(results.soter, null, 2)}\n\n`;
  if (results.soter_error)        context += `ERROR SOTER: ${results.soter_error}\n\n`;
  if (results.poseidon?.length)   context += `DATOS POSEIDON (facturacion):\n${JSON.stringify(results.poseidon, null, 2)}\n\n`;
  if (results.poseidon_error)     context += `ERROR POSEIDON: ${results.poseidon_error}\n\n`;
  if (results.hermes?.length)     context += `DATOS HERMES (emails):\n${JSON.stringify(results.hermes, null, 2)}\n\n`;
  if (results.hermes_error)       context += `ERROR HERMES: ${results.hermes_error}\n\n`;
  if (!results.soter && !results.poseidon && !results.hermes) context += `No se requirieron datos de las bases para esta consulta.\n\n`;

  const finalMessages = [...messages.slice(0, -1), { role: 'user', content: context }];

  try {
    const reply = await callClaude(ORACLE_INTERPRETER_SYSTEM, finalMessages, 1500);
    res.json({ content: [{ type: 'text', text: reply }] });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── BUSINESS — Pipeline 4 agentes con skill completa ───────────────────────────

async function callAgent(system, content, maxTokens) {
  const fullSystem = system + '\n\n===CONTEXTO OPERATIVO PREMIAR (referencia interna)===\n' + BUSINESS_SKILL_CONTEXT;
  return callClaude(fullSystem, [{ role: 'user', content }], maxTokens || 800);
}

app.post('/api/business', requireAuth, async (req, res) => {
  const { caso } = req.body;
  console.log('[BUSINESS] caso recibido, largo:', caso ? caso.length : 0, '| primeros 200 chars:', (caso||'').slice(0,200));
  if (!caso) return res.status(400).json({ error: 'Falta caso' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (event, data) => res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');

  try {
    const casoTruncado = caso.slice(0, 12000); // max 12K chars por caso

    send('progress', { agente: 'Premiar', estado: 'procesando' });
    const routerOut = await callAgent(BUSINESS_AGENTS.router,
      '=== MAIL / CASO A ANALIZAR ===\n' + casoTruncado, 500);
    let clasificacion = {};
    try { clasificacion = JSON.parse((routerOut.match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch(e) { clasificacion = { resumen: routerOut }; }
    const resumenRouter = clasificacion.resumen
      ? `Tipo: ${clasificacion.tipo || '—'} | Urgencia: ${clasificacion.urgencia || '—'}\n${clasificacion.resumen}`
      : routerOut;
    send('progress', { agente: 'Premiar', estado: 'completo', output: resumenRouter });

    send('progress', { agente: 'Suscriptor', estado: 'procesando' });
    const tecnicoOut = await callAgent(BUSINESS_AGENTS.tecnico,
      '=== MAIL / CASO A ANALIZAR ===\n' + casoTruncado +
      '\n\n=== CLASIFICACION DEL ROUTER ===\n' + JSON.stringify(clasificacion, null, 2), 800);
    send('progress', { agente: 'Suscriptor', estado: 'completo', output: tecnicoOut });

    send('progress', { agente: 'Operativo', estado: 'procesando' });
    const operativoOut = await callAgent(BUSINESS_AGENTS.operativo,
      '=== MAIL / CASO A ANALIZAR ===\n' + casoTruncado +
      '\n\n=== CLASIFICACION ===\n' + JSON.stringify(clasificacion, null, 2) +
      '\n\n=== ANALISIS TECNICO ===\n' + tecnicoOut, 1000);
    send('progress', { agente: 'Operativo', estado: 'completo', output: operativoOut });

    send('progress', { agente: 'Validador', estado: 'procesando' });
    const validadorOut = await callAgent(BUSINESS_AGENTS.validador,
      '=== MAIL / CASO A ANALIZAR ===\n' + casoTruncado +
      '\n\n=== ROUTER ===\n' + JSON.stringify(clasificacion, null, 2) +
      '\n\n=== TECNICO ===\n' + tecnicoOut +
      '\n\n=== OPERATIVO ===\n' + operativoOut, 1500);
    send('progress', { agente: 'Validador', estado: 'completo', output: validadorOut });

    send('done', { resultado: validadorOut, clasificacion });
    res.end();
  } catch(err) {
    console.error('Error Business:', err.message);
    send('error', { mensaje: err.message });
    res.end();
  }
});

// ─── BUSINESS — Gmail endpoints ───────────────────────────────────────────────

// Helper: decodificar body de Gmail (robusto para multipart)
function decodeBase64(data) {
  if (!data) return '';
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch(e) { return ''; }
}

function decodeGmailBody(payload, depth) {
  if (!payload) return '';
  depth = depth || 0;
  if (depth > 5) return '';

  // Si tiene data directamente
  if (payload.body && payload.body.data) {
    return decodeBase64(payload.body.data);
  }

  // Buscar en partes - prioridad: text/plain > text/html > recursivo
  if (payload.parts && payload.parts.length > 0) {
    // Primero buscar text/plain
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return decodeBase64(part.body.data);
      }
    }
    // Luego text/html (limpiar tags)
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        const html = decodeBase64(part.body.data);
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
    // Recursivo para multipart
    for (const part of payload.parts) {
      if (part.mimeType && part.mimeType.startsWith('multipart/')) {
        const text = decodeGmailBody(part, depth + 1);
        if (text && text.length > 10) return text;
      }
    }
    // Ultimo recurso: cualquier parte con data
    for (const part of payload.parts) {
      const text = decodeGmailBody(part, depth + 1);
      if (text && text.length > 10) return text;
    }
  }
  return '';
}

app.get('/api/gmail/search', requireAuth, async (req, res) => {
  const q = req.query.q || 'to:pedidos@premiar.seg.ar';
  const maxResults = parseInt(req.query.max) || 15;
  const token = req.user?.accessToken;
  if (!token) return res.status(401).json({ error: 'Sin token de Gmail. Cerrá sesion y volvé a entrar.' });
  try {
    // Buscar IDs
    const searchRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const searchData = await searchRes.json();
    if (!searchRes.ok) return res.status(searchRes.status).json({ error: searchData.error?.message || 'Error Gmail' });
    const messages = searchData.messages || [];
    if (!messages.length) return res.json({ emails: [] });

    // Obtener metadata de cada mensaje en paralelo
    const emailPromises = messages.map(m =>
      fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
        { headers: { Authorization: 'Bearer ' + token } }
      ).then(r => r.json())
    );
    const emails = await Promise.all(emailPromises);

    const result = emails.map(msg => {
      const headers = msg.payload?.headers || [];
      const get = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
      const from = get('From');
      const fromName = from.replace(/<.*>/, '').replace(/"/g, '').trim() || from;
      return {
        id: msg.id,
        threadId: msg.threadId,
        subject: get('Subject'),
        from: from,
        from_name: fromName,
        date: get('Date'),
        snippet: msg.snippet || ''
      };
    });
    res.json({ emails: result });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// Extraer texto de adjuntos
async function extractAttachmentText(token, messageId, attachmentId, mimeType, filename) {
  try {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const data = await res.json();
    if (!data.data) return null;
    const buffer = Buffer.from(data.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const fn = (filename || '').toLowerCase();

    // PDF
    if (mimeType === 'application/pdf' || fn.endsWith('.pdf')) {
      try {
        const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = '';
        const loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(buffer),
          useWorkerFetch: false,
          isEvalSupported: false,
          useSystemFonts: true,
        });
        const pdf = await loadingTask.promise;
        const pageTexts = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          pageTexts.push(content.items.map(item => item.str || '').join(' '));
        }
        const parsed = { text: pageTexts.join('\n') };
        const texto = parsed.text?.replace(/\s+/g, ' ').trim() || '';
        if (texto.length > 50) {
          return { filename, tipo: 'PDF', texto: texto.slice(0, 5000) };
        }
        // PDF escaneado — intentar OCR
        try {
          const worker = await Tesseract.createWorker('spa+eng');
          const { data: ocrData } = await worker.recognize(buffer);
          await worker.terminate();
          const ocrTexto = ocrData.text?.replace(/\s+/g, ' ').trim() || '';
          if (ocrTexto.length > 30) {
            return { filename, tipo: 'PDF_OCR', texto: ocrTexto.slice(0, 5000) };
          }
        } catch(ocrErr) {}
        return { filename, tipo: 'PDF_ESCANEADO', texto: '[PDF escaneado sin texto legible]' };
      } catch(e) {
        return { filename, tipo: 'PDF_ERROR', texto: '[Error procesando PDF: ' + e.message + ']' };
      }
    }

    // Word DOCX
    if (mimeType?.includes('wordprocessingml') || fn.endsWith('.docx')) {
      try {
        const result = await mammoth.extractRawText({ buffer });
        const texto = result.value?.replace(/\s+/g, ' ').trim() || '';
        return { filename, tipo: 'WORD', texto: texto.slice(0, 5000) };
      } catch(e) {
        return { filename, tipo: 'WORD_ERROR', texto: '[Error procesando Word: ' + e.message + ']' };
      }
    }

    // Word DOC legacy
    if (mimeType?.includes('msword') || fn.endsWith('.doc')) {
      return { filename, tipo: 'DOC_LEGACY', texto: '[Formato .doc antiguo — convertir a .docx para leer]' };
    }

    // Imágenes — OCR
    if (mimeType?.startsWith('image/') || fn.match(/\.(jpg|jpeg|png|gif|bmp|tiff|webp)$/i)) {
      try {
        const worker = await Tesseract.createWorker('spa+eng');
        const { data: ocrData } = await worker.recognize(buffer);
        await worker.terminate();
        const texto = ocrData.text?.replace(/\s+/g, ' ').trim() || '';
        if (texto.length > 20) {
          return { filename, tipo: 'IMAGEN_OCR', texto: texto.slice(0, 3000) };
        }
        return { filename, tipo: 'IMAGEN', texto: '[Imagen sin texto legible]' };
      } catch(e) {
        return { filename, tipo: 'IMAGEN_ERROR', texto: '[Error procesando imagen: ' + e.message + ']' };
      }
    }

    // Excel
    if (mimeType?.includes('spreadsheet') || mimeType?.includes('excel') || fn.match(/\.xlsx?$/i)) {
      return { filename, tipo: 'EXCEL', texto: '[Archivo Excel — revisar manualmente]' };
    }

    // CSV / texto plano
    if (mimeType?.includes('text') || fn.match(/\.(txt|csv|xml|json|html)$/i)) {
      return { filename, tipo: 'TEXTO', texto: buffer.toString('utf8').slice(0, 3000) };
    }

    return { filename, tipo: mimeType || 'BINARIO', texto: '[Tipo de archivo no soportado]' };
  } catch(e) {
    return { filename, tipo: 'ERROR', texto: e.message };
  }
}

// Listar adjuntos — excluye imágenes inline de firma, prioriza documentos
function listAttachments(payload, result = []) {
  if (!payload) return result;
  if (payload.filename && payload.body?.attachmentId) {
    const fn = payload.filename.toLowerCase();
    const mime = payload.mimeType || '';
    const size = payload.body.size || 0;
    // Excluir imágenes pequeñas inline (logos de firma < 20KB con nombre genérico image00X)
    const isInlineImage = mime.startsWith('image/') && size < 20000 && /^image\d+\./i.test(payload.filename);
    if (!isInlineImage) {
      result.push({
        filename: payload.filename,
        mimeType: mime,
        attachmentId: payload.body.attachmentId,
        size
      });
    }
  }
  if (payload.parts) {
    payload.parts.forEach(p => listAttachments(p, result));
  }
  return result;
}

// Ordenar adjuntos: PDFs y Word primero, imágenes al final
function sortAttachments(adjuntos) {
  const priority = (a) => {
    const fn = (a.filename || '').toLowerCase();
    if (fn.endsWith('.pdf')) return 0;
    if (fn.endsWith('.docx') || fn.endsWith('.doc')) return 1;
    if (fn.match(/\.(txt|csv|xml|json)$/)) return 2;
    if (a.mimeType?.startsWith('image/')) return 10;
    return 5;
  };
  return adjuntos.sort((a, b) => priority(a) - priority(b));
}

app.get('/api/gmail/message/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const token = req.user?.accessToken;
  if (!token) return res.status(401).json({ error: 'Sin token de Gmail.' });
  try {
    // Usar format=full pero con manejo de mails grandes
    const msgRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
      { headers: { Authorization: 'Bearer ' + token } }
    );
    const msg = await msgRes.json();
    if (!msgRes.ok) return res.status(msgRes.status).json({ error: msg.error?.message });
    const headers = msg.payload?.headers || [];
    const get = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
    const from = get('From');
    
    // Intentar extraer body — si falla o es muy corto, usar snippet
    let body = decodeGmailBody(msg.payload);
    if (!body || body.length < 20) {
      body = msg.snippet || '';
    }
    // Limpiar body
    body = (body || '').replace(/[\r\n]+/g, ' ').trim();

    // Procesar adjuntos — ordenados por relevancia, máx 8
    const adjuntosRaw = listAttachments(msg.payload);
    const adjuntos = sortAttachments(adjuntosRaw);
    const adjuntosTexto = [];
    for (const adj of adjuntos.slice(0, 8)) {
      if (adj.size > 15 * 1024 * 1024) {
        adjuntosTexto.push({ filename: adj.filename, tipo: 'GRANDE', texto: '[Archivo >15MB, omitido]' });
        continue;
      }
      const extracted = await extractAttachmentText(token, id, adj.attachmentId, adj.mimeType, adj.filename);
      if (extracted) adjuntosTexto.push(extracted);
    }

    // Si el body sigue vacío, construir contexto desde headers + snippet + adjuntos
    if (!body || body.length < 20) {
      body = `[Cuerpo del correo no disponible — mail de gran tamaño]
Snippet: ${msg.snippet || ''}`;
    }

    res.json({
      id: msg.id,
      subject: get('Subject'),
      from,
      from_name: from.replace(/<.*>/, '').replace(/"/g, '').trim() || from,
      to: get('To'),
      date: get('Date'),
      body,
      adjuntos: adjuntosTexto,
      snippet: msg.snippet || ''
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Gmail search ─────────────────────────────────────────────────────────────
app.get('/api/gmail/search', requireAuth, async (req, res) => {
  res.status(501).json({ error: 'Gmail directo requiere configuracion adicional. Usa la opcion "Pegar correo".' });
});

// ─── Estáticos protegidos ─────────────────────────────────────────────────────
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`DatStudio en http://localhost:${PORT}`);
  if (process.env.ALLOWED_DOMAIN) console.log(`Dominio permitido: @${process.env.ALLOWED_DOMAIN}`);
});

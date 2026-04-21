require('dotenv').config();

if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {
    constructor() {
      this.a=1;this.b=0;this.c=0;this.d=1;this.e=0;this.f=0;
      this.m11=1;this.m12=0;this.m13=0;this.m14=0;
      this.m21=0;this.m22=1;this.m23=0;this.m24=0;
      this.m31=0;this.m32=0;this.m33=1;this.m34=0;
      this.m41=0;this.m42=0;this.m43=0;this.m44=1;
      this.is2D=true;this.isIdentity=true;
    }
    multiply(){ return this; }
    inverse(){ return this; }
    translate(){ return this; }
    scale(){ return this; }
    rotate(){ return this; }
    transformPoint(p){ return p||{x:0,y:0,z:0,w:1}; }
  };
}
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

// ─── Validaciones ─────────────────────────────────────────────────────────────
const REQUIRED = ['ANTHROPIC_API_KEY','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','SESSION_SECRET','SOTER_DB_URL','POSEIDON_DB_URL','HERMES_DB_URL'];
const missing  = REQUIRED.filter(k => !process.env[k]);
if (missing.length) { console.error('Faltan variables en .env:', missing.join(', ')); process.exit(1); }

const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAIN || null;

// ─── Pools de BD ──────────────────────────────────────────────────────────────
// ─── Pools de BD ──────────────────────────────────────────────────────────────
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
  // Guardar el accessToken para usar con Gmail API
  return done(null, { id: profile.id, name: profile.displayName, email, avatar: profile.photos?.[0]?.value || null, accessToken });
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }
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
- clientes: id, razonsocial, cuit, debt_status_id, debt_status (text notas), debt_review_date, debt_check_date, debt_category_id
  CRITICO: el campo nombre es "razonsocial" (NO "name"). Buscar SIEMPRE por razonsocial ILIKE.
- debt_statuses: id, name, stop_sale (boolean) — join con clientes.debt_status_id
  stop_sale = true → EMISION FRENADA (freno duro de cobranzas)
- debt_categories: id, name — join con clientes.debt_category_id

CONSULTA DE ESTADO DE DEUDA (usar para preguntas de viabilidad de tomador):
SELECT c.razonsocial, c.cuit, ds.name AS estado_deuda, ds.stop_sale AS freno_emision,
       c.debt_status AS notas_deuda, c.debt_review_date, c.debt_check_date, dc.name AS categoria
FROM clientes c
LEFT JOIN debt_statuses ds ON ds.id::bigint = c.debt_status_id
LEFT JOIN debt_categories dc ON dc.id = c.debt_category_id
WHERE c.razonsocial ILIKE '%[nombre]%'

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

// Consulta Poseidon para estado de cobranzas del tomador
async function fetchCobranzasData(tomadorNombre) {
  try {
    if (!tomadorNombre) return null;
    const r = await poseidon.query(
      `SELECT c.razonsocial, c.cuit,
              ds.name AS estado_deuda,
              ds.stop_sale AS freno_emision,
              c.debt_status AS notas_deuda,
              c.debt_review_date,
              c.debt_check_date,
              dc.name AS categoria_deuda
       FROM clientes c
       LEFT JOIN debt_statuses ds ON ds.id::bigint = c.debt_status_id
       LEFT JOIN debt_categories dc ON dc.id = c.debt_category_id
       WHERE c.razonsocial ILIKE $1
       LIMIT 1`,
      ['%' + tomadorNombre + '%']
    );
    if (!r.rows.length) return { encontrado: false };
    return { encontrado: true, ...r.rows[0] };
  } catch(e) {
    console.error('[fetchCobranzasData] Error:', e.message);
    return { error: e.message };
  }
}

function formatCobranzasBlock(cobranzas) {
  const SEP = '\n';
  if (!cobranzas) return '=== ESTADO COBRANZAS ===' + SEP + 'Sin datos (tomador no identificado).';
  if (cobranzas.error) return '=== ESTADO COBRANZAS ===' + SEP + 'Error consultando Poseidon: ' + cobranzas.error;
  if (!cobranzas.encontrado) return '=== ESTADO COBRANZAS ===' + SEP + 'Sin registro en Poseidon — sin antecedentes de deuda.';
  const freno = cobranzas.freno_emision;
  const icono = freno ? '⛔' : (cobranzas.estado_deuda ? '⚠️' : '✅');
  const lineas = [
    '=== ESTADO COBRANZAS (Poseidon) ===',
    icono + ' Estado: ' + (cobranzas.estado_deuda || 'Sin estado de deuda'),
    'Freno de emisión: ' + (freno ? 'SÍ — EMISIÓN BLOQUEADA' : 'No'),
  ];
  if (cobranzas.categoria_deuda) lineas.push('Categoría: ' + cobranzas.categoria_deuda);
  if (cobranzas.debt_review_date) lineas.push('Última revisión: ' + String(cobranzas.debt_review_date).slice(0,10));
  if (cobranzas.notas_deuda) lineas.push('Notas: ' + cobranzas.notas_deuda.slice(0, 400));
  if (freno) lineas.push('→ EMISIÓN BLOQUEADA POR COBRANZAS. El análisis técnico continúa. El Validador debe reflejar este bloqueo en el veredicto final.');
  return lineas.join(SEP);
}

// Consulta Soter para obtener cupos y cúmulos del tomador
async function fetchCuposData(tomadorNombre, tomadorCuit, riesgoNombre) {
  try {
    const resultado = {
      tomador: null,
      cupo_total: null,
      cupo_riesgo: null,
      cumulo_total: null,
      cumulo_riesgo: null,
      riesgo_id: null,
      es_tomador_nuevo: null,
      error: null
    };

    // 1. Buscar person_id por CUIT o nombre
    // El CUIT en Soter vive en policies.cuit (people.cuit está vacío)
    let personRow = null;
    let personId  = null;

    if (tomadorCuit) {
      const cuitLimpio = tomadorCuit.replace(/[-]/g, '');
      // Buscar taker_id desde policies.cuit
      const rPol = await soter.query(
        `SELECT DISTINCT taker_id, taker_name FROM policies
         WHERE REPLACE(COALESCE(cuit,''),'-','') = $1 AND taker_id IS NOT NULL LIMIT 1`, [cuitLimpio]);
      if (rPol.rows.length) {
        personId = rPol.rows[0].taker_id;
        personRow = { id: personId, nombre_completo: (rPol.rows[0].taker_name || '').trim() };
      }
    }

    // Fallback por nombre: buscar en policies.taker_name
    if (!personRow && tomadorNombre) {
      const rPolNombre = await soter.query(
        `SELECT DISTINCT taker_id, taker_name FROM policies
         WHERE LOWER(taker_name) ILIKE $1 AND taker_id IS NOT NULL LIMIT 1`,
        ['%' + tomadorNombre.toLowerCase() + '%']);
      if (rPolNombre.rows.length) {
        personId = rPolNombre.rows[0].taker_id;
        personRow = { id: personId, nombre_completo: (rPolNombre.rows[0].taker_name || '').trim() };
      }
    }

    if (!personRow) {
      resultado.error = 'Tomador no encontrado en Soter (CUIT/nombre sin coincidencia)';
      return resultado;
    }

    personId = personRow.id;
    resultado.tomador = { id: personId, nombre: personRow.nombre_completo };

    // 2. Verificar si es tomador nuevo
    const polCount = await soter.query(
      `SELECT COUNT(*) as cant FROM policies
       WHERE taker_id = $1 AND endorsement_type_id = 1 AND sequence_number = 0`, [personId]);
    resultado.es_tomador_nuevo = parseInt(polCount.rows[0].cant) === 0;

    // 3. Cupo total vigente
    const cupoTotal = await soter.query(
      `SELECT total_quota FROM person_taker_total_cupos
       WHERE person_id = $1 AND from_date <= NOW() AND (until_date IS NULL OR until_date >= NOW())
       ORDER BY until_date DESC LIMIT 1`, [personId]);
    resultado.cupo_total = cupoTotal.rows.length ? parseFloat(cupoTotal.rows[0].total_quota) : null;

    // 4. Buscar risk_id por nombre del riesgo
    if (riesgoNombre) {
      const riesgoQ = await soter.query(
        `SELECT id, name FROM risks WHERE LOWER(name) ILIKE $1 LIMIT 1`,
        ['%' + riesgoNombre.toLowerCase() + '%']);
      if (riesgoQ.rows.length) {
        resultado.riesgo_id = riesgoQ.rows[0].id;
        resultado.riesgo_nombre = riesgoQ.rows[0].name;
      }
    }

    // 5. Cupo por riesgo vigente
    if (resultado.riesgo_id) {
      const cupoRiesgo = await soter.query(
        `SELECT cuota FROM person_taker_risk_cupos
         WHERE person_id = $1 AND risk_id = $2
           AND from_date <= NOW() AND (until_date IS NULL OR until_date >= NOW())
         ORDER BY until_date DESC LIMIT 1`, [personId, resultado.riesgo_id]);
      resultado.cupo_riesgo = cupoRiesgo.rows.length ? parseFloat(cupoRiesgo.rows[0].cuota) : null;
    }

    // 6. Cúmulo actual total y por riesgo (desde policies vigentes)
    const cumuloQ = await soter.query(
      `SELECT MAX(current_cumulus) as cumulo_total,
              MAX(risk_current_cumulus) as cumulo_riesgo
       FROM policies
       WHERE taker_id = $1
         AND endorsement_type_id = 1 AND sequence_number = 0
         AND state IN ('approved','verified','billed','open')
         AND canceled_at IS NULL
         AND ($2::integer IS NULL OR risk_id = $2)`,
      [personId, resultado.riesgo_id || null]);
    if (cumuloQ.rows.length) {
      resultado.cumulo_total = parseFloat(cumuloQ.rows[0].cumulo_total) || 0;
      resultado.cumulo_riesgo = parseFloat(cumuloQ.rows[0].cumulo_riesgo) || 0;
    }

    return resultado;
  } catch(e) {
    console.error('[fetchCuposData] Error:', e.message);
    return { error: 'Error consultando Soter: ' + e.message };
  }
}

// Formatea el bloque de cupos para inyectar al Técnico
function formatCuposBlock(cupos, saUSD) {
  if (!cupos || cupos.error) {
    const motivo = cupos?.error || 'Error desconocido';
    return `=== DATOS DE CUPOS Y CUMULOS (Soter) ===
TOMADOR NO ENCONTRADO EN SOTER: ${motivo}
→ ASUMIR: TOMADOR NUEVO / PRIMER NEGOCIO. Aplicar límites de "Primer Negocio" de la tabla de emisión automática.
→ Cúmulo actual: USD 0 (sin historial). Cupo total: sin asignar aún.
→ Dictaminá directamente con los límites de primer negocio. NO pidas verificación manual ni bloquees el caso por falta de CUIT.
→ Si el CUIT es necesario para emitir en Soter, indicarlo como condición de emisión (no como bloqueo del dictamen).`;
  }

  const fmt = (v) => v != null ? `USD ${Number(v).toLocaleString('es-AR')}` : 'Sin asignar';
  const dispTotal = cupos.cupo_total != null && cupos.cumulo_total != null
    ? cupos.cupo_total - cupos.cumulo_total : null;
  const dispRiesgo = cupos.cupo_riesgo != null && cupos.cumulo_riesgo != null
    ? cupos.cupo_riesgo - cupos.cumulo_riesgo : null;

  let entraTotal = '—';
  let entraRiesgo = '—';
  if (saUSD && dispTotal != null) entraTotal = saUSD <= dispTotal ? 'SI ✅' : 'NO 🔴';
  if (saUSD && dispRiesgo != null) entraRiesgo = saUSD <= dispRiesgo ? 'SI ✅' : 'NO 🔴';

  return `=== DATOS DE CUPOS Y CUMULOS (Soter — consultado ahora) ===
Tomador: ${cupos.tomador?.nombre || '—'} (person_id: ${cupos.tomador?.id || '—'})
Tipo: ${cupos.es_tomador_nuevo ? 'TOMADOR NUEVO (sin polizas previas)' : 'TOMADOR CON HISTORIAL'}
Riesgo identificado: ${cupos.riesgo_nombre || 'No identificado en catalogo'} (risk_id: ${cupos.riesgo_id || '—'})

CUPO TOTAL:     ${fmt(cupos.cupo_total)}
CUMULO TOTAL:   ${fmt(cupos.cumulo_total)}
DISPONIBLE:     ${fmt(dispTotal)}  ${saUSD ? `→ SA USD ${saUSD.toLocaleString('es-AR')} entra: ${entraTotal}` : ''}

CUPO RIESGO:    ${fmt(cupos.cupo_riesgo)}
CUMULO RIESGO:  ${fmt(cupos.cumulo_riesgo)}
DISPONIBLE:     ${fmt(dispRiesgo)}  ${saUSD ? `→ SA USD ${saUSD.toLocaleString('es-AR')} entra: ${entraRiesgo}` : ''}

Con estos datos REALES dictaminá directamente — no pidas verificar en Soter.`;
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
      ? `**Tipo:** ${clasificacion.tipo || '—'} | **Urgencia:** ${clasificacion.urgencia || '—'}\n**Tomador:** ${clasificacion.partes?.tomador || '—'} | **Riesgo:** ${clasificacion.partes?.riesgo || '—'}\n**Resumen:** ${clasificacion.resumen}`
      : routerOut;
    send('progress', { agente: 'Premiar', estado: 'completo', output: resumenRouter });

    // Consultar cupos en Soter con los datos que extrajo el Router
    const tomador = clasificacion?.partes?.tomador || null;
    const riesgo  = clasificacion?.partes?.riesgo  || null;
    const montoStr = clasificacion?.partes?.monto   || null;
    const moneda  = clasificacion?.partes?.moneda   || 'ARS';
    // Extraer CUIT si viene en el caso (patrón XX-XXXXXXXX-X o XXXXXXXXXXX)
    const cuitMatch = casoTruncado.match(/\b(\d{2}-?\d{8}-?\d{1}|\d{11})\b/);
    const cuit = cuitMatch ? cuitMatch[1] : null;
    // Convertir monto a USD aproximado para comparar con límites (si viene en ARS, dividir por TC ~1000 como fallback)
    let saUSD = null;
    if (montoStr) {
      const num = parseFloat(montoStr.replace(/[^\d.]/g, ''));
      if (!isNaN(num)) saUSD = moneda === 'USD' ? num : null; // Solo convertir si viene en USD directamente; ARS queda null
    }

    const [cuposData, cobranzasData] = await Promise.all([
      fetchCuposData(tomador, cuit, riesgo),
      fetchCobranzasData(tomador)
    ]);
    const cuposBlock = formatCuposBlock(cuposData, saUSD);
    const cobranzasBlock = formatCobranzasBlock(cobranzasData);
    console.log('[BUSINESS] Cupos fetched:', JSON.stringify(cuposData));
    console.log('[BUSINESS] Cobranzas fetched:', JSON.stringify(cobranzasData));

    send('progress', { agente: 'Suscriptor', estado: 'procesando' });
    const tecnicoOut = await callAgent(BUSINESS_AGENTS.tecnico,
      '=== MAIL / CASO A ANALIZAR ===\n' + casoTruncado +
      '\n\n=== CLASIFICACION DEL ROUTER ===\n' + JSON.stringify(clasificacion, null, 2) +
      '\n\n' + cuposBlock, 800);
    send('progress', { agente: 'Suscriptor', estado: 'completo', output: tecnicoOut });

    send('progress', { agente: 'Operativo', estado: 'procesando' });
    const operativoOut = await callAgent(BUSINESS_AGENTS.operativo,
      '=== MAIL / CASO A ANALIZAR ===\n' + casoTruncado +
      '\n\n=== CLASIFICACION ===\n' + JSON.stringify(clasificacion, null, 2) +
      '\n\n=== ANALISIS TECNICO ===\n' + tecnicoOut +
      '\n\n' + cobranzasBlock, 1000);
    send('progress', { agente: 'Operativo', estado: 'completo', output: operativoOut });

    send('progress', { agente: 'Validador', estado: 'procesando' });
    const validadorOut = await callAgent(BUSINESS_AGENTS.validador,
      '=== MAIL / CASO A ANALIZAR ===\n' + casoTruncado +
      '\n\n=== ROUTER ===\n' + JSON.stringify(clasificacion, null, 2) +
      '\n\n=== TECNICO ===\n' + tecnicoOut +
      '\n\n=== OPERATIVO ===\n' + operativoOut +
      '\n\n' + cobranzasBlock, 1500);
    send('progress', { agente: 'Validador', estado: 'completo' });

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
  const token = req.user.accessToken;
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
        pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');
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
  const token = req.user.accessToken;
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

// ─── Estaticos protegidos ─────────────────────────────────────────────────────
app.use(requireAuth, express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`DatStudio en http://localhost:${PORT}`);
  if (ALLOWED_DOMAIN) console.log(`Dominio permitido: @${ALLOWED_DOMAIN}`);
});

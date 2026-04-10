# DatStudio · Premiar Caución

Plataforma unificada con login via Google OAuth y dos módulos:
- **ORACLE** — Asistente experto en caución (Claude API con skill de negocio)
- **BUSINESS** — Equipo de agentes para gestión de correos y casos

---

## Requisitos

- Node.js 18 o superior
- API key de Anthropic
- Credenciales OAuth de Google (Google Cloud Console)

---

## Paso 1 — Crear credenciales de Google OAuth

1. Ir a [console.cloud.google.com](https://console.cloud.google.com/)
2. Crear un proyecto nuevo (o usar uno existente)
3. Ir a **APIs y Servicios → Credenciales → Crear credencial → ID de cliente OAuth 2.0**
4. Tipo de aplicación: **Aplicación web**
5. Nombre: `DatStudio Premiar` (o el que quieras)
6. En **URIs de redireccionamiento autorizados** agregar:
   - Desarrollo: `http://localhost:3000/auth/google/callback`
   - Producción: `https://tu-dominio.com/auth/google/callback`
7. Guardar → copiar **Client ID** y **Client Secret**

---

## Paso 2 — Instalar y configurar

```bash
# 1. Entrar a la carpeta del proyecto
cd datstudio

# 2. Instalar dependencias
npm install

# 3. Crear el archivo de configuración
cp .env.example .env

# 4. Editar .env y completar los 4 campos obligatorios:
#    - ANTHROPIC_API_KEY   → tu key de Anthropic
#    - GOOGLE_CLIENT_ID    → del paso 1
#    - GOOGLE_CLIENT_SECRET → del paso 1
#    - SESSION_SECRET      → string aleatorio (ver abajo)
```

Para generar un SESSION_SECRET seguro:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Paso 3 — Iniciar

```bash
npm start
# → http://localhost:3000
```

---

## Restricción por dominio (recomendado)

Para que solo entren usuarios con email `@premiar.com.ar` (por ejemplo):

```env
ALLOWED_DOMAIN=premiar.com.ar
```

Si lo dejás vacío, cualquier cuenta de Google puede acceder.

---

## Estructura del proyecto

```
datstudio/
├── server.js              ← Servidor Express con OAuth + proxy API
├── .env                   ← Variables de entorno (NO subir a Git)
├── .env.example           ← Plantilla de configuración
├── .gitignore
├── package.json
└── public/
    ├── index.html         ← App principal (Oracle + Business)
    └── login.html         ← Pantalla de login con Google
```

---

## Flujo de autenticación

```
Usuario → /login
    │
    └─→ Clic "Continuar con Google"
            │
            └─→ Google OAuth (verifica cuenta)
                    │
                    ├─ Dominio no permitido → /login?error=1
                    │
                    └─ OK → sesión activa → /  (app principal)
```

---

## Flujo de la API

```
Browser (index.html)
    │
    │  POST /api/chat  (sin API key, con cookie de sesión)
    ▼
server.js  ← verifica sesión activa
    │
    │  POST api.anthropic.com/v1/messages  (con API key inyectada)
    ▼
Claude API
```

La API key **nunca sale al browser**. Sin sesión activa, `/api/chat` devuelve 401.

---

## Producción

Cambios necesarios para deploy en servidor:

```env
NODE_ENV=production
BASE_URL=https://tu-dominio.com
```

Y agregar `https://tu-dominio.com/auth/google/callback` en Google Cloud Console.

Las cookies en producción requieren HTTPS (ya configurado automáticamente con `NODE_ENV=production`).

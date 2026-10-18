const express = require('express');
const session = require('express-session');
const passport = require('passport');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const ejs = require('ejs');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../logger');
const { DatabaseSessionStore } = require('./sessionStore');

// Characters that could end an inline <script> element or break JS parsing
// (U+2028/U+2029 are line terminators in older engines).
const UNSAFE_SCRIPT_CHARS = new RegExp('[<>&' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

// JSON for embedding in an inline <script> in a view: <%- safeJson(value) %>.
function safeJson(value) {
  return JSON.stringify(value).replace(UNSAFE_SCRIPT_CHARS, ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

function createWebServer(client) {
  const app = express();

  // The bot only speaks HTTP, so an https DASHBOARD_URL means a TLS proxy sits
  // in front: trust it (one hop) unless TRUST_PROXY=false says otherwise.
  const dashboardIsHttps = /^https:\/\//i.test(config.web.dashboardUrl);
  const trustProxy = process.env.TRUST_PROXY === 'true' || (process.env.TRUST_PROXY !== 'false' && dashboardIsHttps);
  if (trustProxy) {
    app.set('trust proxy', 1);
  }
  if (dashboardIsHttps && !trustProxy) {
    logger.warn('DASHBOARD_URL is https but TRUST_PROXY=false: the secure session cookie will be refused and dashboard login will fail');
  }

  const viewsDir = path.join(__dirname, 'views');
  app.set('view engine', 'ejs');
  app.set('views', viewsDir);

  // Pre-read header/footer templates
  const headerTpl = fs.readFileSync(path.join(viewsDir, 'partials', 'header.ejs'), 'utf8');
  const footerTpl = fs.readFileSync(path.join(viewsDir, 'partials', 'footer.ejs'), 'utf8');

  // Compile them as EJS functions
  const headerFn = ejs.compile(headerTpl);
  const footerFn = ejs.compile(footerTpl);

  // Security headers (compatible with Cloudflare proxy)
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://ajax.cloudflare.com", "https://static.cloudflareinsights.com"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://cdn.jsdelivr.net", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "https://cdn.discordapp.com", "data:"],
        connectSrc: ["'self'", "https://cloudflareinsights.com"],
      },
    },
  }));

  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  // The public appeal route parses its own (smaller) body, so skip the global
  // parsers there; otherwise they would run first and its limit never applies.
  const jsonParser = express.json({ limit: '100kb' });
  const formParser = express.urlencoded({ extended: true, limit: '100kb' });
  const skipForAppeals = parser => (req, res, next) => (req.path.startsWith('/appeal/') ? next() : parser(req, res, next));
  app.use(skipForAppeals(jsonParser));
  app.use(skipForAppeals(formParser));

// Session config
  app.use(session({
    store: new DatabaseSessionStore(),
    secret: config.web.sessionSecret,
    resave: false,
    saveUninitialized: false,
    proxy: trustProxy,
    cookie: {
      // Browsers drop secure cookies over plain http, which would make login
      // loop, so follow the dashboard's scheme rather than NODE_ENV.
      secure: dashboardIsHttps,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      httpOnly: true
    },
  }));

  app.use(passport.initialize());
  app.use(passport.session());

  require('./routes/auth').setupPassport();

  // Inject header/footer HTML + user into all renders
  app.use((req, res, next) => {
    res.locals.user = req.user || null;
    res.locals.client = client;
    res.locals.safeJson = safeJson;
    // Make header/footer available as pre-rendered HTML
    const originalRender = res.render.bind(res);
    res.render = function (view, locals = {}, callback) {
      const merged = { ...res.locals, ...locals };
      merged.header = headerFn(merged);
      merged.footer = footerFn(merged);
      originalRender(view, { ...locals, header: merged.header, footer: merged.footer }, callback);
    };
    next();
  });

  // Rate limiting
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });

  // CSRF protection for API routes. Browsers cannot send a cross-origin
  // application/json request without a CORS preflight (which we never allow),
  // so every state-changing request must be real JSON. A body-less request is
  // only accepted when the browser says it came from the dashboard itself.
  let dashboardOrigin = null;
  try {
    dashboardOrigin = new URL(config.web.dashboardUrl).origin;
  } catch {
    logger.warn(`DASHBOARD_URL "${config.web.dashboardUrl}" is not a valid URL; the API origin check is disabled`);
  }
  // The page the request came from is ours when its origin is DASHBOARD_URL's,
  // or when it names the host this request was sent to (dashboard reached by
  // IP or another name than DASHBOARD_URL).
  function isOwnOrigin(req, origin) {
    if (dashboardOrigin && origin === dashboardOrigin) return true;
    try {
      return new URL(origin).host === req.get('host');
    } catch {
      return false;
    }
  }
  function csrfGuard(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const origin = req.headers.origin;
    if (origin && !isOwnOrigin(req, origin)) {
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
    if (req.is('application/json')) return next();
    const hasBody = req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0');
    if (!hasBody && origin) return next();
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }

  const dashboardLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Public appeal route (no auth required, strict rate limit)
  const appealLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.' },
  });
  app.use('/appeal', appealLimiter, require('./routes/appeal')(client));

  app.use('/auth', require('./routes/auth').router);
  app.use('/dashboard', dashboardLimiter, require('./routes/dashboard')(client));
  app.use('/giveaways', dashboardLimiter, require('./routes/giveaways')(client));
  app.use('/api', apiLimiter, csrfGuard, require('./routes/api')(client));

  app.get('/', (req, res) => {
    if (req.isAuthenticated()) {
      return res.redirect('/dashboard');
    }
    res.render('login', { user: null, title: 'Login' });
  });

  // Async route errors reach here through next(err). Log them and answer
  // without Express's default page, which includes the stack trace.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    // Client errors raised by middleware (a body over the size limit, malformed
    // JSON) carry their own 4xx status and a message that is safe to show.
    const status = Number(err.status || err.statusCode);
    if (status >= 400 && status < 500) {
      const message = err.expose ? err.message : 'Bad request';
      return req.originalUrl.startsWith('/api/') || req.is('application/json')
        ? res.status(status).json({ error: message })
        : res.status(status).send(message);
    }
    logger.error(`Unhandled web error on ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
    if (req.originalUrl.startsWith('/api/')) {
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.status(500).send('Internal server error');
    }
  });

  return app;
}

module.exports = { createWebServer };

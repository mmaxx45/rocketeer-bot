const express = require('express');
const session = require('express-session');
const passport = require('passport');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const ejs = require('ejs');
const path = require('path');
const fs = require('fs');
const config = require('../config');

function createWebServer(client) {
  const app = express();

  if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
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
        styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
        imgSrc: ["'self'", "https://cdn.discordapp.com", "data:"],
        connectSrc: ["'self'", "https://cloudflareinsights.com"],
      },
    },
  }));

  app.use(express.static(path.join(__dirname, '..', '..', 'public')));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Session config
  app.use(session({
    secret: config.web.sessionSecret,
    resave: false,
    saveUninitialized: false,
    proxy: process.env.TRUST_PROXY === 'true',
    cookie: {
      secure: process.env.NODE_ENV === 'production',
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

  // CSRF protection for API routes — require JSON content type
  // Browsers cannot send cross-origin JSON POST without CORS preflight
  function csrfGuard(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
    next();
  }

  app.use('/auth', require('./routes/auth').router);
  app.use('/dashboard', require('./routes/dashboard')(client));
  app.use('/api', apiLimiter, csrfGuard, require('./routes/api')(client));

  app.get('/', (req, res) => {
    if (req.isAuthenticated()) {
      return res.redirect('/dashboard');
    }
    res.render('login', { user: null, title: 'Login' });
  });

  return app;
}

module.exports = { createWebServer };

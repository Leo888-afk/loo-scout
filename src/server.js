const express = require('express');
const helmet = require('helmet');
const path = require('path');
const { initDb } = require('./db');
const { sessionMiddleware } = require('./auth');
const apiRoutes = require('./routes');

const PORT = parseInt(process.env.PORT, 10) || 3000;

async function main() {
  // Behind Render's proxy so secure cookies work.
  // (Express 4: trust proxy with a number trusts that many hops.)
  const db = await initDb();
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet({
    // Leaflet + OSM tiles come from CDNs; the CSP below allows them.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://unpkg.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
        imgSrc: ["'self'", 'data:', 'https://*.tile.openstreetmap.org', 'https://server.arcgisonline.com', 'https://unpkg.com'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'https://unpkg.com'],
      },
    },
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(await sessionMiddleware(db));
  app.use('/api', apiRoutes(db));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  // Fallback for the SPA hash routes (anything non-API that isn't a file).
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  app.listen(PORT, () => {
    console.log(`Loo Scout listening on port ${PORT}`);
  });
  return app;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  // Required as a module (e.g. tests): export the app promise without
  // starting a second listener.
  module.exports = main();
}

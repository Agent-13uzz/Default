'use strict';
const { createApp } = require('./app');
const { seed, DEMO_PASSWORD } = require('./seed');

const port = Number(process.env.PORT) || 3000;
const ctx = createApp();

if (process.env.KEYSTONE_SEED !== 'false' && seed(ctx)) {
  console.log(`Seeded demo data. Log in as admin@keystone.test / ${DEMO_PASSWORD}`);
}

const server = ctx.app.listen(port, () => console.log(`Keystone running at http://localhost:${port}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      ctx.close();
      process.exit(0);
    });
  });
}

import { createApp } from './app';
import { env } from './config/env';
import { connectMongo, closeMongo } from './db/mongo/client';
import { initPostgres, pgPool } from './db/postgres/client';

async function bootstrap() {
  await connectMongo();
  await initPostgres();

  const app = createApp();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });

  const close = async () => {
    await app.close();
    await pgPool.end();
    await closeMongo();
    process.exit(0);
  };

  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});

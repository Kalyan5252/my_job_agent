import { createApp } from './app';
import { env } from './config/env';
import { closeMongo, connectMongo } from './db/mongo/client';
import { closePostgres, initPostgres } from './db/postgres/client';
import { installShutdown } from './lib/shutdown';
import { closeRedis } from './queues/apply.queue';
import { SessionService } from './services/session.service';
import { BrowserTool } from './tools/browser.tool';

async function bootstrap() {
  await connectMongo();
  await initPostgres();

  const app = createApp();
  await app.listen({ port: env.PORT, host: env.HOST });

  installShutdown('api', async () => {
    await app.close();
    await SessionService.closeAll();
    await BrowserTool.closePool();
    await closeRedis();
    await closePostgres();
    await closeMongo();
  });
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});

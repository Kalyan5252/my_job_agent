import { closeMongo, connectMongo } from '../db/mongo/client';
import { installShutdown } from '../lib/shutdown';
import { closeRedis } from './apply.queue';
import { startDiscoveryWorkers } from './discovery.worker';

async function main() {
  await connectMongo();
  const workers = startDiscoveryWorkers();
  installShutdown('discovery-worker', async () => {
    await Promise.all([
      workers.scrapeWorker.close(),
      workers.scoreWorker.close(),
      workers.writeWorker.close(),
    ]);
    await closeRedis();
    await closeMongo();
  });
  console.log('Discovery workers started');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

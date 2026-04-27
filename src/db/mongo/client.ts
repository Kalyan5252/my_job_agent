import { Collection, Db, MongoClient } from 'mongodb';
import { env } from '../../config/env';
import { ScoredJob } from '../../types';

let mongoClient: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (db) return db;

  mongoClient = new MongoClient(env.MONGODB_URI);
  await mongoClient.connect();
  db = mongoClient.db(env.MONGODB_DB_NAME);
  return db;
}

export async function jobsCollection(): Promise<Collection<ScoredJob>> {
  const database = await connectMongo();
  return database.collection<ScoredJob>('jobs');
}

export async function closeMongo(): Promise<void> {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    db = null;
  }
}

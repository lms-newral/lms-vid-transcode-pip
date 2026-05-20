import { Redis } from 'ioredis';
import { env } from './env.js';

export function createRedisConnection() {
  return new Redis({
    host: env.redis.host,
    port: env.redis.port,
    password: env.redis.password,
    tls: env.redis.tls ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

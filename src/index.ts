import 'dotenv/config';
import { Worker } from 'bullmq';
import { env, assertRequiredEnv } from './config/env.js';
import { logger } from './logger.js';
import { createRedisConnection } from './config/redis.js';
import { createAceS3Client } from './storage/ace-s3.client.js';
import { S3Service } from './storage/s3.service.js';
import { CallbackService } from './services/callback.service.js';
import { AbrDrmProcessor } from './transcode/abr-drm.processor.js';
import type { TranscodeAbrJobPayload } from './types/transcode-job.interface.js';
import { assertCommandExists } from './utils/command.js';

async function bootstrap() {
  assertRequiredEnv();
  await assertRuntimeTools();

  const redis = createRedisConnection();
  const processor = new AbrDrmProcessor(new S3Service(createAceS3Client()), new CallbackService());

  const worker = new Worker<TranscodeAbrJobPayload>(
    env.queueName,
    async (job) => {
      if (job.name !== env.jobName) {
        logger.warn({ jobId: job.id, jobName: job.name }, 'Skipping unknown job name');
        return;
      }

      await processor.process(job);
    },
    {
      connection: redis,
      concurrency: env.worker.concurrency,
      lockDuration: env.worker.lockDurationMs,
      lockRenewTime: env.worker.lockRenewTimeMs,
      maxStalledCount: 1,
    },
  );

  worker.on('ready', () => {
    logger.info(
      {
        queueName: env.queueName,
        jobName: env.jobName,
        concurrency: env.worker.concurrency,
        s3Endpoint: env.s3.endpoint,
        s3Bucket: env.s3.bucket,
      },
      'Video transcoding worker ready',
    );
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, lessonId: job.data.lessonId }, 'Job completed');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, lessonId: job?.data.lessonId, error }, 'Job failed');
  });

  worker.on('stalled', (jobId) => {
    logger.error({ jobId }, 'Job stalled; it may be retried by BullMQ');
  });

  await setupShutdown(worker, redis);
}

async function assertRuntimeTools() {
  await assertCommandExists('ffmpeg');
  await assertCommandExists('ffprobe');
  await assertCommandExists('packager', ['--version']);
}

async function setupShutdown(worker: Worker<TranscodeAbrJobPayload>, redis: ReturnType<typeof createRedisConnection>) {
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down worker');
    await worker.close();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((error) => {
  logger.fatal({ error }, 'Failed to start video transcoding worker');
  process.exit(1);
});

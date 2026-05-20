import path from 'node:path';
import { z } from 'zod';

const optionalString = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().optional(),
);

const boolFromString = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
}, z.boolean());

const optionalBoolFromString = z.preprocess((value) => {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') return value;
  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
}, z.boolean().optional());

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  QUEUE_NAME: z.string().default('video-transcoding-v2'),
  JOB_NAME: z.string().default('transcode-abr'),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: optionalString,
  REDIS_TLS: boolFromString.default(false),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  WORKER_LOCK_DURATION_MS: z.coerce.number().int().positive().default(7_200_000),
  WORKER_LOCK_RENEW_TIME_MS: z.coerce.number().int().positive().default(60_000),
  ACE_S3_ENDPOINT: optionalString,
  AWS_ENDPOINT_URL_S3: optionalString,
  S3_ENDPOINT: optionalString,
  ACE_S3_REGION: optionalString,
  AWS_REGION: optionalString,
  ACE_S3_BUCKET: optionalString,
  AWS_S3_BUCKET: optionalString,
  S3_BUCKET_NAME: optionalString,
  ACE_S3_ACCESS_KEY_ID: optionalString,
  AWS_ACCESS_KEY_ID: optionalString,
  ACE_S3_SECRET_ACCESS_KEY: optionalString,
  AWS_SECRET_ACCESS_KEY: optionalString,
  ACE_S3_FORCE_PATH_STYLE: optionalBoolFromString,
  S3_FORCE_PATH_STYLE: optionalBoolFromString,
  ACE_S3_STORAGE_CLASS: z.string().default('STANDARD'),
  S3_STORAGE_CLASS: optionalString,
  BACKEND_URL: optionalString,
  INTERNAL_VIDEO_SECRET: optionalString,
  WORK_DIR: z.string().default('/tmp/lms-vid-transcode-pip'),
  MIN_FREE_DISK_BYTES: z.coerce.number().int().positive().default(15_000_000_000),
  SEGMENT_DURATION_SECONDS: z.coerce.number().positive().default(2),
  FFMPEG_THREADS: z.coerce.number().int().positive().default(6),
  X264_PRESET: z.string().default('veryfast'),
  CLEANUP_WORK_DIR: boolFromString.default(true),
});

const parsed = envSchema.parse(process.env);

export const env = {
  nodeEnv: parsed.NODE_ENV,
  queueName: parsed.QUEUE_NAME,
  jobName: parsed.JOB_NAME,
  redis: {
    host: parsed.REDIS_HOST,
    port: parsed.REDIS_PORT,
    password: parsed.REDIS_PASSWORD,
    tls: parsed.REDIS_TLS,
  },
  worker: {
    concurrency: parsed.WORKER_CONCURRENCY,
    lockDurationMs: parsed.WORKER_LOCK_DURATION_MS,
    lockRenewTimeMs: parsed.WORKER_LOCK_RENEW_TIME_MS,
  },
  s3: {
    endpoint: parsed.ACE_S3_ENDPOINT || parsed.AWS_ENDPOINT_URL_S3 || parsed.S3_ENDPOINT,
    region: parsed.ACE_S3_REGION || parsed.AWS_REGION || 'us-east-1',
    bucket: parsed.ACE_S3_BUCKET || parsed.AWS_S3_BUCKET || parsed.S3_BUCKET_NAME || '',
    accessKeyId: parsed.ACE_S3_ACCESS_KEY_ID || parsed.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: parsed.ACE_S3_SECRET_ACCESS_KEY || parsed.AWS_SECRET_ACCESS_KEY || '',
    forcePathStyle: parsed.ACE_S3_FORCE_PATH_STYLE ?? parsed.S3_FORCE_PATH_STYLE ?? true,
    storageClass: parsed.ACE_S3_STORAGE_CLASS || parsed.S3_STORAGE_CLASS || 'STANDARD',
  },
  backend: {
    url: parsed.BACKEND_URL?.replace(/\/$/, ''),
    internalSecret: parsed.INTERNAL_VIDEO_SECRET,
  },
  processing: {
    workDir: path.resolve(parsed.WORK_DIR),
    minFreeDiskBytes: parsed.MIN_FREE_DISK_BYTES,
    segmentDurationSeconds: parsed.SEGMENT_DURATION_SECONDS,
    ffmpegThreads: parsed.FFMPEG_THREADS,
    x264Preset: parsed.X264_PRESET,
    cleanupWorkDir: parsed.CLEANUP_WORK_DIR,
  },
};

export function assertRequiredEnv() {
  const missing: string[] = [];

  if (!env.s3.bucket) missing.push('ACE_S3_BUCKET');
  if (!env.s3.accessKeyId) missing.push('ACE_S3_ACCESS_KEY_ID');
  if (!env.s3.secretAccessKey) missing.push('ACE_S3_SECRET_ACCESS_KEY');
  if (!env.backend.url) missing.push('BACKEND_URL');
  if (!env.backend.internalSecret) missing.push('INTERNAL_VIDEO_SECRET');

  if (missing.length > 0) {
    throw new Error(`Missing required worker environment variables: ${missing.join(', ')}`);
  }
}

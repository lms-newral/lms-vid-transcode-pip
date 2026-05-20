import { S3Client } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

export function createAceS3Client() {
  return new S3Client({
    region: env.s3.region,
    endpoint: env.s3.endpoint,
    forcePathStyle: env.s3.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: env.s3.accessKeyId,
      secretAccessKey: env.s3.secretAccessKey,
    },
    maxAttempts: 5,
  });
}

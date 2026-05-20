import pino from 'pino';
import { env } from './config/env.js';

export const logger = pino({
  level: env.nodeEnv === 'production' ? 'info' : 'debug',
  base: { service: 'lms-vid-transcode-pip' },
  redact: {
    paths: [
      '*.contentKey',
      '*.DRM_CONTENT_KEY',
      '*.ACE_S3_SECRET_ACCESS_KEY',
      '*.AWS_SECRET_ACCESS_KEY',
      '*.INTERNAL_VIDEO_SECRET',
      'headers.x-internal-secret',
    ],
    censor: '[redacted]',
  },
});

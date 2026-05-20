import { env } from '../config/env.js';
import type { TranscodeCallbackPayload } from '../types/transcode-job.interface.js';
import { logger } from '../logger.js';

export class CallbackService {
  async sendSuccess(payload: TranscodeCallbackPayload) {
    await this.postWithRetry('/internal/video/callback', payload, `${payload.lessonId} success callback`);
    logger.info({ lessonId: payload.lessonId }, 'Backend success callback accepted');
  }

  async sendFailure(lessonId: string, error: string) {
    await this.postWithRetry('/internal/video/callback/failure', { lessonId, error }, `${lessonId} failure callback`);
    logger.info({ lessonId }, 'Backend failure callback accepted');
  }

  private async postWithRetry(path: string, body: unknown, label: string) {
    let lastError: unknown;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      try {
        const response = await fetch(`${env.backend.url}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-internal-secret': env.backend.internalSecret || '',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`${label} failed with HTTP ${response.status}: ${text}`);
        }

        return;
      } catch (error) {
        lastError = error;
        if (attempt === 3) break;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
  }
}

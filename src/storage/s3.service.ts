import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { S3Client, StorageClass } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';
import { logger } from '../logger.js';

const mimeMap: Record<string, string> = {
  '.m3u8': 'application/x-mpegURL',
  '.mpd': 'application/dash+xml',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export class S3Service {
  constructor(private readonly client: S3Client) {}

  async getObjectSize(key: string) {
    logger.info({ key, bucket: env.s3.bucket }, 'Checking source object metadata');
    const response = await this.client.send(
      new HeadObjectCommand({
        Bucket: env.s3.bucket,
        Key: key,
      }),
    );

    const size = response.ContentLength || 0;
    logger.info({ key, size }, 'Source object metadata loaded');
    return size;
  }

  async downloadToFile(key: string, destinationPath: string) {
    logger.info({ key, destinationPath }, 'Downloading source video from S3');
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: env.s3.bucket,
        Key: key,
      }),
    );

    if (!(response.Body instanceof Readable)) {
      throw new Error(`S3 object body is not readable for key ${key}`);
    }

    await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
    await pipeline(response.Body, fs.createWriteStream(destinationPath));
    const stat = await fsPromises.stat(destinationPath);
    logger.info({ key, destinationPath, size: stat.size }, 'Source video downloaded');
  }

  async uploadDirectory(localDir: string, s3Prefix: string) {
    const files = await walkFiles(localDir);
    logger.info({ localDir, s3Prefix, fileCount: files.length }, 'Uploading packaged outputs to S3');
    await runLimited(files, 4, async (filePath) => {
      const relative = path.relative(localDir, filePath).split(path.sep).join('/');
      const key = `${s3Prefix.replace(/\/$/, '')}/${relative}`;
      await this.uploadFile(filePath, key);
    });
    logger.info({ s3Prefix, fileCount: files.length }, 'Packaged outputs uploaded to S3');
  }

  private async uploadFile(filePath: string, key: string) {
    const ext = path.extname(filePath).toLowerCase();
    const cacheControl =
      ext === '.m3u8' || ext === '.mpd'
        ? 'no-cache, no-store'
        : 'public, max-age=31536000, immutable';

    const upload = new Upload({
      client: this.client,
      queueSize: 4,
      partSize: 64 * 1024 * 1024,
      params: {
        Bucket: env.s3.bucket,
        Key: key,
        Body: fs.createReadStream(filePath),
        ContentType: mimeMap[ext] || 'application/octet-stream',
        CacheControl: cacheControl,
        StorageClass: env.s3.storageClass as StorageClass,
      },
    });

    await upload.done();
    logger.debug({ key, filePath }, 'Uploaded output file');
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkFiles(fullPath);
      if (entry.isFile()) return [fullPath];
      return [];
    }),
  );

  return files.flat();
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) await worker(item);
    }
  });

  await Promise.all(workers);
}

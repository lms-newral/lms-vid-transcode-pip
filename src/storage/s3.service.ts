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

    const startTime = Date.now();
    await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
    await pipeline(response.Body, fs.createWriteStream(destinationPath));
    const stat = await fsPromises.stat(destinationPath);
    
    const durationSec = (Date.now() - startTime) / 1000;
    const sizeMb = stat.size / (1024 * 1024);
    const speedMBps = durationSec > 0 ? (sizeMb / durationSec).toFixed(2) : '0.00';
    const speedMbps = durationSec > 0 ? ((sizeMb * 8) / durationSec).toFixed(2) : '0.00';

    logger.info({ key, size: stat.size, durationSec, speedMBps, speedMbps }, `Source video downloaded at ${speedMBps} MB/s (${speedMbps} Mbps)`);
  }

  async uploadDirectory(localDir: string, s3Prefix: string) {
    const files = await walkFiles(localDir);
    logger.info({ localDir, s3Prefix, fileCount: files.length }, `Starting S3 upload of ${files.length} packaged files`);
    const startTime = Date.now();
    let totalBytes = 0;
    let uploadedCount = 0;
    let lastLogTime = Date.now();

    await runLimited(files, 50, async (filePath) => {
      const stat = await fsPromises.stat(filePath);
      totalBytes += stat.size;
      const relative = path.relative(localDir, filePath).split(path.sep).join('/');
      const key = `${s3Prefix.replace(/\/$/, '')}/${relative}`;
      await this.uploadFile(filePath, key);
      
      uploadedCount++;
      const now = Date.now();
      // Log progress every 2 seconds or on the very last file
      if (now - lastLogTime > 2000 || uploadedCount === files.length) {
        const percent = Math.round((uploadedCount / files.length) * 100);
        logger.info(`S3 Upload Progress: ${uploadedCount}/${files.length} files (${percent}%)`);
        lastLogTime = now;
      }
    });

    const durationSec = (Date.now() - startTime) / 1000;
    const sizeMb = totalBytes / (1024 * 1024);
    const speedMBps = durationSec > 0 ? (sizeMb / durationSec).toFixed(2) : '0.00';
    const speedMbps = durationSec > 0 ? ((sizeMb * 8) / durationSec).toFixed(2) : '0.00';

    logger.info({ s3Prefix, fileCount: files.length, totalBytes, durationSec, speedMBps, speedMbps }, `Packaged outputs uploaded to S3 at ${speedMBps} MB/s (${speedMbps} Mbps)`);
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

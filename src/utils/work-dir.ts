import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { runCommand } from './command.js';

export async function createJobWorkDirs(lessonId: string) {
  const safeLessonId = lessonId.replace(/[^a-zA-Z0-9._-]/g, '_');
  const root = path.join(env.processing.workDir, safeLessonId, crypto.randomUUID());
  const intermediateDir = path.join(root, 'intermediate');
  const packageDir = path.join(root, 'package');

  await fs.mkdir(intermediateDir, { recursive: true });
  await fs.mkdir(packageDir, { recursive: true });

  return {
    root,
    intermediateDir,
    packageDir,
    inputPath: path.join(root, 'input.mp4'),
  };
}

export async function cleanupWorkDir(root: string) {
  if (!env.processing.cleanupWorkDir) return;
  await fs.rm(root, { recursive: true, force: true });
}

export async function assertDiskSpace(workDir: string, expectedInputBytes: number) {
  await fs.mkdir(workDir, { recursive: true });

  const result = await runCommand('df', ['-Pk', workDir], { label: 'disk space check' });
  const lines = result.stdout.trim().split('\n');
  const dataLine = lines[lines.length - 1];
  const parts = dataLine?.split(/\s+/);
  const availableKilobytes = Number(parts?.[3] || 0);
  const availableBytes = availableKilobytes * 1024;
  const requiredBytes = Math.max(env.processing.minFreeDiskBytes, expectedInputBytes * 6);

  if (availableBytes < requiredBytes) {
    throw new Error(
      `Insufficient disk space. Available ${formatBytes(availableBytes)}, required ${formatBytes(requiredBytes)}.`,
    );
  }
}

function formatBytes(bytes: number) {
  return `${Math.round(bytes / 1024 / 1024)}MB`;
}

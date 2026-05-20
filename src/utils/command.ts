import { spawn } from 'node:child_process';
import { logger } from '../logger.js';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; label?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const label = options.label || command;

  logger.debug({ command, args, cwd: options.cwd, label }, 'Starting command');

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString('utf8'));
      trimChunks(stdoutChunks);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString('utf8'));
      trimChunks(stderrChunks);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');

      if (code === 0) {
        logger.debug({ label }, 'Command finished');
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${label} failed with exit code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

export async function runJsonCommand<T>(command: string, args: string[]) {
  const result = await runCommand(command, args, { label: command });
  return JSON.parse(result.stdout) as T;
}

export async function assertCommandExists(command: string, args = ['-version']) {
  await runCommand(command, args, { label: `${command} availability` });
}

function trimChunks(chunks: string[]) {
  const maxChars = 40_000;
  while (chunks.join('').length > maxChars && chunks.length > 1) {
    chunks.shift();
  }
}

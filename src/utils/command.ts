import { spawn } from 'node:child_process';
import { logger } from '../logger.js';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; label?: string; env?: NodeJS.ProcessEnv; onProgress?: (line: string) => void } = {},
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

    let buffer = '';
    let lastLogTime = Date.now();
    let latestLine = '';

    const processOutput = (chunk: Buffer, chunksArr: string[]) => {
      const text = chunk.toString('utf8');
      chunksArr.push(text);
      trimChunks(chunksArr);

      if (options.onProgress) {
        buffer += text;
        const lines = buffer.split(/\r?\n|\r/);
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.trim()) latestLine = line.trim();
        }

        const now = Date.now();
        if (now - lastLogTime > 5000 && latestLine) {
          options.onProgress(latestLine);
          lastLogTime = now;
          latestLine = '';
        }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => processOutput(chunk, stdoutChunks));
    child.stderr.on('data', (chunk: Buffer) => processOutput(chunk, stderrChunks));

    child.on('error', reject);
    child.on('close', (code) => {
      // Flush any remaining progress buffer
      if (options.onProgress && latestLine) {
        options.onProgress(latestLine);
      }

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

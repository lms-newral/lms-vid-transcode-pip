import { runJsonCommand } from '../utils/command.js';
import { logger } from '../logger.js';
import type { VideoProbe } from '../types/transcode-job.interface.js';

interface FfprobeOutput {
  format?: {
    duration?: string;
    start_time?: string;
  };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    duration?: string;
    start_time?: string;
  }>;
}

export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const metadata = await runJsonCommand<FfprobeOutput>('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);

  const videoStream = metadata.streams?.find((stream) => stream.codec_type === 'video');
  if (!videoStream?.width || !videoStream.height) {
    throw new Error('No video stream found in uploaded file');
  }

  const formatDuration = Number(metadata.format?.duration || 0);
  const formatStartTime = Number(metadata.format?.start_time || 0);

  // If the container has a non-zero start_time, the real content duration
  // is (duration - start_time). Many recording tools embed the wall-clock
  // start offset, which inflates the reported duration.
  const actualDuration = formatStartTime > 1
    ? Math.round(formatDuration - formatStartTime)
    : Math.round(formatDuration);

  if (formatStartTime > 1) {
    logger.warn(
      { formatDuration, formatStartTime, actualDuration },
      'Source video has non-zero start_time — timestamps will be normalized to zero',
    );
  }

  return {
    duration: Math.max(1, actualDuration),
    width: videoStream.width,
    height: videoStream.height,
    fps: parseFps(videoStream.avg_frame_rate || videoStream.r_frame_rate || '25/1'),
    hasAudio: metadata.streams?.some((stream) => stream.codec_type === 'audio') || false,
    videoCodec: videoStream.codec_name || '',
  };
}

function parseFps(value: string) {
  const [numerator, denominator] = value.split('/').map(Number);
  if (!numerator || !denominator) return 25;
  return Math.min(60, Math.max(1, numerator / denominator));
}

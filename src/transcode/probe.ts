import { runJsonCommand } from '../utils/command.js';
import type { VideoProbe } from '../types/transcode-job.interface.js';

interface FfprobeOutput {
  format?: {
    duration?: string;
  };
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
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

  return {
    duration: Math.max(1, Math.round(Number(metadata.format?.duration || 0))),
    width: videoStream.width,
    height: videoStream.height,
    fps: parseFps(videoStream.avg_frame_rate || videoStream.r_frame_rate || '25/1'),
    hasAudio: metadata.streams?.some((stream) => stream.codec_type === 'audio') || false,
  };
}

function parseFps(value: string) {
  const [numerator, denominator] = value.split('/').map(Number);
  if (!numerator || !denominator) return 25;
  return Math.min(60, Math.max(1, numerator / denominator));
}

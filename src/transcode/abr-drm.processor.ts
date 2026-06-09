import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../logger.js';
import type { TranscodeAbrJobPayload, VideoProbe } from '../types/transcode-job.interface.js';
import { S3Service } from '../storage/s3.service.js';
import { CallbackService } from '../services/callback.service.js';
import { assertDiskSpace, cleanupWorkDir, createJobWorkDirs } from '../utils/work-dir.js';
import { runCommand } from '../utils/command.js';
import { resolveDrmKeys } from '../utils/drm-keys.js';
import { probeVideo } from './probe.js';

const renditionSettings = [
  {
    name: '1080p',
    width: 1920,
    height: 1080,
    bitrate: '5000k',
    maxrate: '5350k',
    bufsize: '7500k',
    drmLabel: 'HD',
    bandwidth: 5_000_000,
  },
  {
    name: '720p',
    width: 1280,
    height: 720,
    bitrate: '2800k',
    maxrate: '2996k',
    bufsize: '4200k',
    drmLabel: 'HD',
    bandwidth: 2_800_000,
  },
  {
    name: '480p',
    width: 854,
    height: 480,
    bitrate: '1400k',
    maxrate: '1498k',
    bufsize: '2100k',
    drmLabel: 'SD',
    bandwidth: 1_400_000,
  },
] as const;

export class AbrDrmProcessor {
  constructor(
    private readonly s3: S3Service,
    private readonly callbacks: CallbackService,
  ) {}

  async process(job: Job<TranscodeAbrJobPayload>) {
    const payload = job.data;
    const lessonId = requireNonEmpty(payload.lessonId, 'lessonId');
    const rawS3Key = requireNonEmpty(payload.rawS3Key || payload.s3Key, 'rawS3Key');
    const outputPrefix = payload.outputPrefix || `tenants/${payload.tenantId}/lessons/${lessonId}/videos`;
    const drmKeys = resolveDrmKeys(payload);
    const inputSize = payload.fileSize || (await this.s3.getObjectSize(rawS3Key));
    const dirs = await createJobWorkDirs(lessonId);

    try {
      logger.info({ jobId: job.id, lessonId, rawS3Key, outputPrefix }, 'Starting ABR DRM transcode job');
      await job.updateProgress(3);

      await assertDiskSpace(env.processing.workDir, inputSize);
      logger.info({ lessonId, inputSize, workDir: env.processing.workDir }, 'Disk space check passed');
      await job.updateProgress(8);

      await this.s3.downloadToFile(rawS3Key, dirs.inputPath);
      await job.updateProgress(15);

      const probe = await probeVideo(dirs.inputPath);
      logger.info({ lessonId, probe }, 'Input video metadata');
      await job.updateProgress(20);

      await this.generateThumbnail(dirs.inputPath, path.join(dirs.packageDir, 'thumbnail.jpg'), probe.duration);
      await job.updateProgress(24);

      logger.info({ lessonId }, 'Starting FFmpeg ABR transcode');
      const validRenditions = await this.transcodeRenditions(dirs.inputPath, dirs.intermediateDir, probe);
      logger.info({ lessonId, intermediateDir: dirs.intermediateDir, variants: validRenditions.map(r => r.name) }, 'FFmpeg ABR transcode complete');
      await job.updateProgress(60);

      logger.info({ lessonId, packageDir: dirs.packageDir }, 'Starting Shaka DRM packaging');
      await this.packageWithShaka(dirs.intermediateDir, dirs.packageDir, drmKeys, validRenditions);
      logger.info({ lessonId, packageDir: dirs.packageDir }, 'Shaka DRM packaging complete');
      await job.updateProgress(78);

      await this.s3.uploadDirectory(dirs.packageDir, outputPrefix);
      await job.updateProgress(92);

      logger.info({ lessonId }, 'Sending backend success callback');
      await this.callbacks.sendSuccess({
        lessonId,
        masterUrl: `${outputPrefix}/master.m3u8`,
        thumbnailUrl: fsSync.existsSync(path.join(dirs.packageDir, 'thumbnail.jpg'))
          ? `${outputPrefix}/thumbnail.jpg`
          : undefined,
        duration: probe.duration,
        variants: [],
        isDrm: true,
        dashManifestUrl: `${outputPrefix}/manifest.mpd`,
      });

      await job.updateProgress(100);
      logger.info({ jobId: job.id, lessonId }, 'ABR DRM transcode job complete');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isFinalAttempt(job)) {
        logger.error({ lessonId, message }, 'Final job attempt failed; sending backend failure callback');
        await this.callbacks.sendFailure(lessonId, message).catch((callbackError) => {
          logger.error({ callbackError, lessonId }, 'Failed to send failure callback');
        });
      } else {
        logger.warn(
          {
            lessonId,
            attemptsMade: job.attemptsMade,
            configuredAttempts: job.opts.attempts,
            message,
          },
          'Job attempt failed; leaving backend status unchanged until final attempt',
        );
      }
      throw error;
    } finally {
      await cleanupWorkDir(dirs.root).catch((error) => {
        logger.warn({ error, lessonId }, 'Failed to clean job work directory');
      });
    }
  }

  private async transcodeRenditions(inputPath: string, intermediateDir: string, probe: VideoProbe) {
    const gopFrames = Math.max(24, Math.round(probe.fps * env.processing.segmentDurationSeconds));
    
    // Filter out renditions that are strictly larger than the input video
    // We always keep at least the lowest rendition if the input is smaller than all of them
    const validRenditions = renditionSettings.filter((r, i) => r.height <= probe.height || i === renditionSettings.length - 1);

    const filterGraph = validRenditions
      .map((rendition, index) => {
        let targetH = Math.min(rendition.height, probe.height);
        let targetW = Math.round(targetH * (probe.width / probe.height));
        // Ensure dimensions are even
        targetW = Math.round(targetW / 2) * 2;
        targetH = Math.round(targetH / 2) * 2;
        
        logger.info({ rendition: rendition.name, targetW, targetH }, 'Calculated GPU scaling dimensions');
        
        return `[v${index}]scale_cuda=w=${targetW}:h=${targetH}[v${rendition.name}]`;
      })
      .join(';');

    const args = [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-fflags',
      '+genpts',
      '-err_detect',
      'ignore_err',
      '-hwaccel',
      'cuda',
      '-hwaccel_output_format',
      'cuda',
      '-analyzeduration',
      '100M',
      '-probesize',
      '100M',
      '-i',
      inputPath,
      '-filter_complex',
      `[0:v]split=${validRenditions.length}${validRenditions.map((_, index) => `[v${index}]`).join('')};${filterGraph}`,
    ];

    for (const rendition of validRenditions) {
      args.push(
        '-map',
        `[v${rendition.name}]`,
        '-c:v',
        'h264_nvenc',
        '-preset',
        env.processing.nvencPreset,
        '-tune',
        'hq',
        '-rc',
        'vbr',
        '-cq',
        '28',
        '-multipass',
        'qres',
        '-bf',
        '3',
        '-profile:v',
        'high',
        '-level',
        rendition.name === '1080p' ? '4.1' : '3.1',
        '-r',
        String(Math.round(probe.fps)),
        '-g',
        String(gopFrames),
        '-keyint_min',
        String(gopFrames),
        '-sc_threshold',
        '0',
        '-force_key_frames',
        `expr:gte(t,n_forced*${env.processing.segmentDurationSeconds})`,
        '-b:v',
        rendition.bitrate,
        '-maxrate',
        rendition.maxrate,
        '-bufsize',
        rendition.bufsize,
        '-an',
        '-movflags',
        '+faststart',
        path.join(intermediateDir, `${rendition.name}_raw.mp4`),
      );
    }

    if (probe.hasAudio) {
      args.push(
        '-map',
        '0:a:0',
        '-vn',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-af',
        'aresample=async=1:first_pts=0',
        '-movflags',
        '+faststart',
        path.join(intermediateDir, 'audio_raw.mp4'),
      );
    }

    logger.info({ 
      renditions: validRenditions.map(r => r.name), 
      preset: env.processing.nvencPreset,
      hwaccel: 'cuda' 
    }, 'Executing hardware-accelerated NVENC FFmpeg command');

    await runCommand('ffmpeg', args, { label: 'ffmpeg ABR transcode' });

    if (!probe.hasAudio) {
      logger.info('Input has no audio track; generating silent audio');
      await runCommand(
        'ffmpeg',
        [
          '-hide_banner',
          '-nostdin',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'anullsrc=channel_layout=stereo:sample_rate=48000',
          '-t',
          String(probe.duration),
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ar',
          '48000',
          '-ac',
          '2',
          '-movflags',
          '+faststart',
          path.join(intermediateDir, 'audio_raw.mp4'),
        ],
        { label: 'ffmpeg silent audio' },
      );
    }

    return validRenditions;
  }

  private async packageWithShaka(
    intermediateDir: string,
    packageDir: string,
    keys: { keyIdHex: string; contentKeyHex: string },
    validRenditions: typeof renditionSettings[number][],
  ) {
    await Promise.all(
      [...validRenditions.map((rendition) => rendition.name), 'audio'].map((folder) =>
        fs.mkdir(path.join(packageDir, folder), { recursive: true }),
      ),
    );

    const streamDescriptors = validRenditions.map((rendition) =>
      [
        `in=${path.join(intermediateDir, `${rendition.name}_raw.mp4`)}`,
        'stream=video',
        `init_segment=${path.join(packageDir, rendition.name, 'init.mp4')}`,
        `segment_template=${path.join(packageDir, rendition.name, 'segment_$Number$.m4s')}`,
        `playlist_name=${rendition.name}/main.m3u8`,
        `drm_label=${rendition.drmLabel}`,
        `bandwidth=${rendition.bandwidth}`,
      ].join(','),
    );

    streamDescriptors.push(
      [
        `in=${path.join(intermediateDir, 'audio_raw.mp4')}`,
        'stream=audio',
        `init_segment=${path.join(packageDir, 'audio', 'init.mp4')}`,
        `segment_template=${path.join(packageDir, 'audio', 'segment_$Number$.m4s')}`,
        'playlist_name=audio/main.m3u8',
        'hls_group_id=audio',
        'hls_name=audio',
        'drm_label=AUDIO',
        'bandwidth=128000',
      ].join(','),
    );

    await runCommand(
      'packager',
      [
        ...streamDescriptors,
        '--segment_duration',
        String(env.processing.segmentDurationSeconds),
        '--fragment_duration',
        String(env.processing.segmentDurationSeconds),
        '--enable_raw_key_encryption',
        '--keys',
        `label=HD:key_id=${keys.keyIdHex}:key=${keys.contentKeyHex},label=SD:key_id=${keys.keyIdHex}:key=${keys.contentKeyHex},label=AUDIO:key_id=${keys.keyIdHex}:key=${keys.contentKeyHex}`,
        '--protection_scheme',
        'cenc',
        '--protection_systems',
        'Widevine,PlayReady',
        '--clear_lead',
        '0',
        '--hls_playlist_type',
        'VOD',
        '--mpd_output',
        path.join(packageDir, 'manifest.mpd'),
        '--hls_master_playlist_output',
        path.join(packageDir, 'master.m3u8'),
      ],
      { label: 'shaka package DRM ABR' },
    );
  }

  private async generateThumbnail(inputPath: string, outputPath: string, duration: number) {
    const seekSeconds = Math.floor(duration / 2);
    await runCommand(
      'ffmpeg',
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-ss',
        String(seekSeconds),
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        outputPath,
      ],
      { label: 'ffmpeg thumbnail' },
    ).catch((error) => {
      logger.warn({ error }, 'Thumbnail generation failed; continuing without thumbnail');
    });
  }
}

function requireNonEmpty(value: string | undefined, field: string) {
  if (!value || value.trim() === '') throw new Error(`Missing required job field: ${field}`);
  return value;
}

function isFinalAttempt(job: Job<TranscodeAbrJobPayload>) {
  const configuredAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
  return job.attemptsMade + 1 >= configuredAttempts;
}

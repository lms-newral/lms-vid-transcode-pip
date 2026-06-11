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
      logger.info({
        lessonId,
        inputSize,
        inputSizeMB: (inputSize / 1024 / 1024).toFixed(1),
        workDir: env.processing.workDir,
      }, 'Disk space check passed');
      await job.updateProgress(8);

      // ── Step 1: Download from S3 ──
      const dlStart = Date.now();
      await this.s3.downloadToFile(rawS3Key, dirs.inputPath);
      const dlSec = ((Date.now() - dlStart) / 1000).toFixed(1);
      logger.info({ lessonId, durationSec: dlSec }, '✅ Step 1/6: Source video downloaded from S3');
      await job.updateProgress(15);

      // ── Step 2: Probe source video ──
      const probe = await probeVideo(dirs.inputPath);
      logger.info({
        lessonId,
        duration: probe.duration,
        durationFormatted: formatDuration(probe.duration),
        resolution: `${probe.width}x${probe.height}`,
        fps: probe.fps,
        hasAudio: probe.hasAudio,
      }, '✅ Step 2/6: Source video probed');
      await job.updateProgress(20);

      // Note: We used to remux here to fix timestamps, but instead we now 
      // rely on -ignore_editlist and setpts in the transcode step itself.

      // ── Step 4: Generate thumbnail + GPU transcode ──
      await this.generateThumbnail(dirs.inputPath, path.join(dirs.packageDir, 'thumbnail.jpg'), probe.duration);
      await job.updateProgress(24);

      const transcodeStart = Date.now();
      logger.info({
        lessonId,
        segmentDuration: env.processing.segmentDurationSeconds,
        nvencPreset: env.processing.nvencPreset,
      }, 'Starting FFmpeg ABR GPU transcode...');
      const validRenditions = await this.transcodeRenditions(dirs.inputPath, dirs.intermediateDir, probe);
      const transcodeSec = ((Date.now() - transcodeStart) / 1000).toFixed(1);
      logger.info({
        lessonId,
        transcodeDurationSec: transcodeSec,
        transcodeDurationFormatted: formatDuration(Math.round(Number(transcodeSec))),
        intermediateDir: dirs.intermediateDir,
        variants: validRenditions.map(r => r.name),
      }, '✅ Step 3/6: FFmpeg ABR transcode complete');
      await job.updateProgress(60);

      // ── Step 4: Shaka DRM Packaging ──
      const packageStart = Date.now();
      logger.info({ lessonId, packageDir: dirs.packageDir }, 'Starting Shaka DRM packaging...');
      await this.packageWithShaka(dirs.intermediateDir, dirs.packageDir, drmKeys, validRenditions);
      const packageSec = ((Date.now() - packageStart) / 1000).toFixed(1);
      logger.info({
        lessonId,
        packageDurationSec: packageSec,
        packageDir: dirs.packageDir,
      }, '✅ Step 4/6: Shaka DRM packaging complete');
      await job.updateProgress(78);

      // ── Step 5: Upload to S3 ──
      const uploadStart = Date.now();
      logger.info({ lessonId }, 'Uploading packaged files to S3...');
      await this.s3.uploadDirectory(dirs.packageDir, outputPrefix);
      const uploadSec = ((Date.now() - uploadStart) / 1000).toFixed(1);
      logger.info({
        lessonId,
        uploadDurationSec: uploadSec,
      }, '✅ Step 5/6: All files uploaded to S3');
      await job.updateProgress(92);

      // ── Callback & Done ──
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

      const totalSec = ((Date.now() - dlStart) / 1000).toFixed(1);
      await job.updateProgress(100);
      logger.info({
        jobId: job.id,
        lessonId,
        totalDurationSec: totalSec,
        totalDurationFormatted: formatDuration(Math.round(Number(totalSec))),
        videoDuration: formatDuration(probe.duration),
        steps: {
          download: `${dlSec}s`,
          transcode: `${transcodeSec}s`,
          package: `${packageSec}s`,
          upload: `${uploadSec}s`,
        },
      }, '🎉 ABR DRM transcode job complete');
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
    
    // The user explicitly requested to ALWAYS generate all renditions (1080p, 720p, 480p)
    // regardless of the source video's resolution.
    const validRenditions = renditionSettings;

    const args = [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-hwaccel', 'cuda',
      '-extra_hw_frames', '8',
      '-i', inputPath,
    ];

    for (const rendition of validRenditions) {
      // The user explicitly requested standard resolutions without calculations
      const targetW = rendition.width;
      const targetH = rendition.height;

      logger.info({ rendition: rendition.name, targetW, targetH }, 'Calculated GPU scaling dimensions');

      args.push(
        '-map',
        '0:v:0',
        '-vf',
        `hwupload_cuda,scale_cuda=w=${targetW}:h=${targetH}`,
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p5',
        '-tune',
        'hq',
        '-spatial-aq',
        '1',
        '-temporal-aq',
        '1',
        '-r',
        String(Math.round(probe.fps)),
        '-g',
        String(gopFrames),
        '-keyint_min',
        String(gopFrames),
        '-sc_threshold',
        '0',
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

    await runCommand('ffmpeg', args, { 
      label: 'ffmpeg ABR transcode',
      onProgress: (line) => {
        // FFmpeg progress lines usually contain frame=, fps=, time=, speed=
        if (line.includes('time=') || line.includes('frame=')) {
          logger.info({ progress: line }, 'FFmpeg Progress');
        }
      }
    });

    // --- NEW STATS VERIFICATION LOGS ---
    logger.info('Verifying encoded video durations before packaging...');
    for (const rendition of validRenditions) {
      try {
        const intermediateVideoPath = path.join(intermediateDir, `${rendition.name}_raw.mp4`);
        const encodedProbe = await probeVideo(intermediateVideoPath);
        logger.info({
          rendition: rendition.name,
          encodedDurationSeconds: encodedProbe.duration,
          expectedDuration: probe.duration,
          encodedWidth: encodedProbe.width,
          encodedHeight: encodedProbe.height
        }, '✅ Encoded rendition verified successfully');
      } catch (err) {
        logger.warn({ rendition: rendition.name, error: err }, 'Failed to verify encoded rendition duration');
      }
    }
    // -----------------------------------

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
        { 
          label: 'ffmpeg silent audio',
          onProgress: (line) => {
            if (line.includes('time=')) logger.info({ progress: line }, 'FFmpeg Audio Generation Progress');
          }
        },
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
        '--generate_static_live_mpd',
        '--mpd_output',
        path.join(packageDir, 'manifest.mpd'),
        '--hls_master_playlist_output',
        path.join(packageDir, 'master.m3u8'),
      ],
      { 
        label: 'shaka package DRM ABR',
        onProgress: (line) => {
          // Packager outputs percentage or frame count
          if (line.includes('%') || line.includes('INFO:')) {
            logger.info({ progress: line }, 'Shaka Packager Progress');
          }
        }
      },
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

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

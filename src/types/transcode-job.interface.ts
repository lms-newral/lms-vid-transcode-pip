export type VariantName = '1080p' | '720p' | '480p';

export interface TranscodeAbrJobPayload {
  jobId?: string;
  lessonId: string;
  tenantId: string;
  s3Key?: string;
  rawS3Key?: string;
  videoAssetId?: string;
  fileSize?: number;
  outputPrefix?: string;
  pipeline?: 'ABR_DRM';
  adaptiveStreaming?: boolean;
  variants?: VariantName[];
  drmKeyId?: string;
  contentKey?: string;
}

export interface VideoProbe {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export interface TranscodeCallbackPayload {
  lessonId: string;
  masterUrl: string;
  thumbnailUrl?: string;
  duration: number;
  variants: [];
  isDrm: true;
  dashManifestUrl: string;
}

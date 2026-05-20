# lms-vid-transcode-pip

BullMQ worker for the LMS `confirmVideoUploadV2` flow.

The worker consumes jobs from `video-transcoding-v2`, downloads the raw upload from ACE Cloud / S3-compatible storage, creates 480p/720p/1080p adaptive renditions, packages them with Shaka Packager using raw-key DRM, uploads DASH/HLS outputs to storage, and calls the existing LMS backend internal video callback.

This repo does not modify or depend on `lms-video-worker`.

## Job Contract

Queue:

```txt
video-transcoding-v2
```

Job name:

```txt
transcode-abr
```

Expected payload:

```json
{
  "lessonId": "lesson-id",
  "tenantId": "tenant-id",
  "rawS3Key": "tenants/t1/raw-uploads/lesson.mp4",
  "s3Key": "tenants/t1/raw-uploads/lesson.mp4",
  "fileSize": 123456789,
  "outputPrefix": "tenants/t1/lessons/lesson-id/videos",
  "drmKeyId": "optional-job-key-id",
  "contentKey": "optional-job-content-key"
}
```

`drmKeyId` and `contentKey` must come from the backend queue payload. The worker does not use static DRM keys from env.

## Output

```txt
tenants/{tenantId}/lessons/{lessonId}/videos/master.m3u8
tenants/{tenantId}/lessons/{lessonId}/videos/manifest.mpd
tenants/{tenantId}/lessons/{lessonId}/videos/1080p/init.mp4
tenants/{tenantId}/lessons/{lessonId}/videos/1080p/segment_1.m4s
tenants/{tenantId}/lessons/{lessonId}/videos/720p/init.mp4
tenants/{tenantId}/lessons/{lessonId}/videos/720p/segment_1.m4s
tenants/{tenantId}/lessons/{lessonId}/videos/480p/init.mp4
tenants/{tenantId}/lessons/{lessonId}/videos/480p/segment_1.m4s
tenants/{tenantId}/lessons/{lessonId}/videos/audio/init.mp4
tenants/{tenantId}/lessons/{lessonId}/videos/audio/segment_1.m4s
tenants/{tenantId}/lessons/{lessonId}/videos/thumbnail.jpg
```

## Environment

Copy `.env.example` to `.env` and fill ACE/S3, Redis, backend, and DRM values.

Important ACE/S3 settings:

```env
ACE_S3_ENDPOINT=https://your-ace-s3-endpoint
ACE_S3_REGION=us-east-1
ACE_S3_BUCKET=your-bucket
ACE_S3_ACCESS_KEY_ID=your-access-key
ACE_S3_SECRET_ACCESS_KEY=your-secret-key
ACE_S3_FORCE_PATH_STYLE=true
```

## Commands

```bash
npm install
npm run dev
npm run build
npm start
```

The VM must have:

```txt
ffmpeg
ffprobe
packager
```

The Dockerfile installs FFmpeg and downloads the Shaka Packager binary.

## Docker

Build the worker image:

```bash
docker compose build worker
```

Run the worker against Redis/backend running on your host machine:

```bash
docker compose up worker
```

Inside Docker, `localhost` means the worker container, not your Mac/VM host. The compose file therefore overrides:

```env
REDIS_HOST=host.docker.internal
BACKEND_URL=http://host.docker.internal:3000
```

Backend and worker must use the same Redis instance. If backend is using a Redis container exposed on host port `6379`, the default compose setup is enough.

To let this compose file also run Redis:

```bash
DOCKER_REDIS_HOST=redis docker compose --profile redis up worker redis
```

Then make sure `lms-backend` also points to that same Redis instance, for example through host port `6379`.

On Apple Silicon, the compose file pins the worker to `linux/amd64` because the Shaka Packager binary is downloaded as `packager-linux-x64`.

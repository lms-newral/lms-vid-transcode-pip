# ── Stage 1: TypeScript build ──
FROM node:20-bookworm-slim AS ts-builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2: Download Shaka Packager ──
FROM ubuntu:22.04 AS tool-downloader
ARG DEBIAN_FRONTEND=noninteractive
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4 \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN curl -L https://github.com/shaka-project/shaka-packager/releases/latest/download/packager-linux-x64 -o /usr/local/bin/packager
RUN chmod +x /usr/local/bin/packager

# ── Stage 3: Compile FFmpeg with CUDA filter support ──
# Use devel image (includes nvcc compiler + CUDA headers)
FROM nvidia/cuda:12.2.2-devel-ubuntu22.04 AS ffmpeg-builder
ARG DEBIAN_FRONTEND=noninteractive

RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4 \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
     build-essential git pkg-config yasm nasm \
     libx264-dev libfdk-aac-dev libmp3lame-dev libopus-dev \
     libnuma-dev \
  && rm -rf /var/lib/apt/lists/*

# Pin nv-codec-headers to n12.0.16.1 (compatible with CUDA 12.2 + FFmpeg 6.0)
RUN git clone --branch n12.0.16.1 --depth 1 \
    https://git.videolan.org/git/ffmpeg/nv-codec-headers.git /tmp/nv-codec-headers \
  && cd /tmp/nv-codec-headers \
  && make install \
  && rm -rf /tmp/nv-codec-headers

# Pin FFmpeg to n6.0 (confirmed compatible with nv-codec-headers 12.0)
# scale_cuda + hwupload_cuda + h264_nvenc all supported in 6.0
RUN git clone --depth 1 --branch n6.0 https://git.ffmpeg.org/ffmpeg.git /tmp/ffmpeg \
  && cd /tmp/ffmpeg \
  && ./configure \
     --prefix=/usr/local \
     --enable-gpl \
     --enable-nonfree \
     --enable-cuda-nvcc \
     --enable-libx264 \
     --enable-libfdk-aac \
     --enable-libmp3lame \
     --enable-libopus \
     --extra-cflags="-I/usr/local/cuda/include" \
     --extra-ldflags="-L/usr/local/cuda/lib64" \
  && make -j$(nproc) \
  && make install \
  && rm -rf /tmp/ffmpeg

# ── Stage 4: Production runtime ──
FROM nvidia/cuda:12.2.2-runtime-ubuntu22.04

WORKDIR /app
ARG DEBIAN_FRONTEND=noninteractive
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4 \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
     ca-certificates curl dumb-init \
     libx264-163 libfdk-aac2 libmp3lame0 libopus0 \
     libnuma1 \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

# Copy custom-compiled FFmpeg binaries + shared libs
COPY --from=ffmpeg-builder /usr/local/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg-builder /usr/local/bin/ffprobe /usr/local/bin/ffprobe
COPY --from=ffmpeg-builder /usr/local/lib/lib*.so* /usr/local/lib/
RUN ldconfig

# Copy Shaka Packager
COPY --from=tool-downloader /usr/local/bin/packager /usr/local/bin/packager

# Install Node dependencies
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=ts-builder /app/dist ./dist

RUN mkdir -p /work /tmp/lms-vid-transcode-pip

ENV NODE_ENV=production
ENV WORK_DIR=/work
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]

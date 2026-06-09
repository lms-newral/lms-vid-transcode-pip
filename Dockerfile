FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM debian:bookworm-slim AS tool-downloader
ARG DEBIAN_FRONTEND=noninteractive
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4 \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN curl -L https://github.com/shaka-project/shaka-packager/releases/latest/download/packager-linux-x64 -o /usr/local/bin/packager
RUN chmod +x /usr/local/bin/packager

FROM nvidia/cuda:12.2.2-base-ubuntu22.04

WORKDIR /app
ARG DEBIAN_FRONTEND=noninteractive
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4 \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl dumb-init ffmpeg \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

COPY --from=tool-downloader /usr/local/bin/packager /usr/local/bin/packager
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

RUN mkdir -p /work /tmp/lms-vid-transcode-pip

ENV NODE_ENV=production
ENV WORK_DIR=/work
ENV NVIDIA_VISIBLE_DEVICES=all
ENV NVIDIA_DRIVER_CAPABILITIES=compute,video,utility

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]

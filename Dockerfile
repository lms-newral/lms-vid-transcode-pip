FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM alpine:3.20 AS tool-downloader
RUN apk add --no-cache curl
RUN curl -L https://github.com/shaka-project/shaka-packager/releases/latest/download/packager-linux-x64 -o /usr/local/bin/packager
RUN chmod +x /usr/local/bin/packager

FROM node:20-alpine

WORKDIR /app
RUN apk add --no-cache ffmpeg

COPY --from=tool-downloader /usr/local/bin/packager /usr/local/bin/packager
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist

RUN mkdir -p /tmp/lms-vid-transcode-pip && chown -R node:node /tmp/lms-vid-transcode-pip
USER node

CMD ["node", "dist/index.js"]

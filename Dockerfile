FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=4300 DATA_DIR=/data MODEL_CACHE=/data/models
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js vision.js ./
COPY lib ./lib
COPY public ./public
EXPOSE 4300
CMD ["node", "server.js"]

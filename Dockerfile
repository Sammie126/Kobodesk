FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/kobodesk.db TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--no-warnings", "src/index.js"]

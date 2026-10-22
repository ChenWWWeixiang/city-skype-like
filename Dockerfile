FROM node:22-alpine

WORKDIR /app

# better-sqlite3 需要在 Alpine 上编译原生模块
RUN apk add --no-cache python3 make g++ sqlite-dev

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm i -D esbuild

COPY . .

# 前端打包
RUN node build.js

ENV PORT=5173 \
    CITY_DB=/data/city.db \
    NODE_ENV=production

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 5173

CMD ["node", "server/index.js"]

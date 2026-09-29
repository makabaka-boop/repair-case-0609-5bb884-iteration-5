# ---- 核验台镜像：构建前端，并内置 Chromium 供 verify 服务运行 E2E ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts vitest.config.ts playwright.config.ts index.html ./
COPY src ./src
COPY tests ./tests
COPY e2e ./e2e
RUN npx tsc --noEmit && npx vite build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
# Playwright Chromium 运行所需系统库
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# 安装全部依赖（serve / vitest / playwright 等，含 devDependencies），再拉取 Chromium
RUN npm ci --include=dev && npx playwright install chromium
COPY --from=build /app/dist ./dist
COPY tsconfig.json vite.config.ts vitest.config.ts playwright.config.ts ./
COPY src ./src
COPY tests ./tests
COPY e2e ./e2e
COPY scripts ./scripts
ENV NODE_ENV=production
EXPOSE 8080
# 默认启动纯静态 web 服务（只读本地文件，不含任何后端接口）
CMD ["npx", "serve", "-s", "dist", "-l", "tcp://0.0.0.0:8080"]

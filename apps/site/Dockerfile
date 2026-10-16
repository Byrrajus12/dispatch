# Railway builds this from the GitHub source on every push to main that touches
# what the site reads (the watch patterns in .railway/railway.ts). The build
# context is the repo root, not apps/site/, because the build needs workspace
# deps (@dispatch/tokens) and files outside the app: the frozen protocol
# versions and the desktop app's tauri.conf.json (see apps/site/moon.yml).
#
# The build stage is Debian, not Alpine: astro pulls sharp, whose prebuilt
# native binaries are glibc-first. Only the runtime stage is Alpine/bun.
FROM node:24-slim AS build
WORKDIR /app
# Keep this pin in step with .prototools and package.json's packageManager.
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY . .
# Only the site and what it depends on, rather than every workspace package.
RUN pnpm install --frozen-lockfile --filter "@dispatch/site..."
RUN pnpm --filter @dispatch/site run build

FROM oven/bun:1-alpine
WORKDIR /app
COPY apps/site/server.ts apps/site/serverPaths.ts ./
COPY --from=build /app/apps/site/dist ./dist

EXPOSE 3000
CMD ["bun", "run", "server.ts"]

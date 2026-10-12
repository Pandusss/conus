FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci
RUN npm run build -w @conus/server -w @conus/ui

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/Pandusss/conus" \
      org.opencontainers.image.description="Conus: a task manager your AI agents keep themselves" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production CONUS_UI_DIR=/app/ui PORT=8080
# Runtime-only native/external deps, pinned to the versions in package-lock.json.
RUN npm init -y >/dev/null && npm install --omit=dev pg@8.23.1 @node-rs/argon2@2.2.2 && npm cache clean --force
# Code stays root-owned and read-only for the unprivileged runtime user.
COPY --from=build /src/packages/server/dist ./dist
COPY --from=build /src/packages/ui/dist ./ui
USER node
EXPOSE 8080
CMD ["node", "dist/main.mjs"]

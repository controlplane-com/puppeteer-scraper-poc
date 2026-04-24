# syntax=docker/dockerfile:1

# Build deps in the -dev variant (has npm), then copy into the distroless runtime.
FROM cgr.dev/chainguard/node:latest-dev AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

FROM cgr.dev/chainguard/node:latest
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT []
CMD ["node", "src/server.js"]

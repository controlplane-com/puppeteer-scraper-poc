# syntax=docker/dockerfile:1

# -dev variant: we need npm at runtime to install the cpln CLI below.
FROM cgr.dev/chainguard/node:latest-dev

USER root
RUN npm install -g @controlplane/cli \
 && npm cache clean --force \
 && cpln --version

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY src ./src
COPY public ./public

RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Chainguard's default entrypoint is `node`; reset so CMD is a full argv.
ENTRYPOINT []
CMD ["node", "src/server.js"]

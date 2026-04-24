# syntax=docker/dockerfile:1

# Official Puppeteer image — Chrome version matches the puppeteer npm package.
FROM ghcr.io/puppeteer/puppeteer:23.6.0

USER root
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && chown -R pptruser:pptruser /app

COPY --chown=pptruser:pptruser src ./src

USER pptruser

ENV NODE_ENV=production

CMD ["node", "src/scrape.js"]

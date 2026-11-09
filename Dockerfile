# GMS complaint portal container. Runs the Express server on port 3000.
# Configure at runtime with DATABASE_URL, SESSION_SECRET, AI_PROVIDER, AI_API_KEY and optional RESEND_API_KEY.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Install only production dependencies, from the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY web ./web

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/Home.html || exit 1

CMD ["node", "server/app.js"]

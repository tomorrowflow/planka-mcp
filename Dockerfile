FROM node:22.12-alpine AS builder

# Install pnpm
RUN npm install -g pnpm

# Set environment variables to avoid prompts
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true

# Copy the entire project
COPY . /app

WORKDIR /app

# Use --no-frozen-lockfile to allow lockfile updates
RUN pnpm install --no-frozen-lockfile

# Build the project
RUN npm run build

FROM node:22.12-alpine AS release

# Install pnpm
RUN npm install -g pnpm

# Set environment variables to avoid prompts
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV CI=true

COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/pnpm-lock.yaml /app/pnpm-lock.yaml

ENV NODE_ENV=production

WORKDIR /app

# Create directory for attachments
RUN mkdir -p /app/attachments

# Use --force to skip prompts
RUN pnpm install --prod --force --ignore-scripts

# Define volume for attachments
VOLUME ["/app/attachments"]

# Expose HTTP port
EXPOSE 3008

# Health check (use 127.0.0.1 instead of localhost for IPv4)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3008/health || exit 1

# Run the HTTP server (changed from index.js to http-server.js)
ENTRYPOINT ["node", "dist/http-server.js"]

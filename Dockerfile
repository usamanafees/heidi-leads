# heidi-leads: the whole pipeline in one image.
#   docker build -t heidi-leads .
#   docker run --rm --env-file .env -v "$PWD/data:/app/data" -v "$PWD/output:/app/output" \
#     -v "$PWD/google-keys.json:/app/google-keys.json:ro" heidi-leads pipeline
# Any npm script works as the command: score, export, sheets, test, ...
FROM node:24-slim

WORKDIR /app
ENV NODE_ENV=production

# dependencies first, so code changes don't invalidate the install layer
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY config ./config
COPY src ./src
COPY scripts ./scripts
COPY test ./test
COPY .claude ./.claude

# state (embedded Postgres) and results live in mounted volumes
VOLUME ["/app/data", "/app/output"]

ENTRYPOINT ["npm", "run", "--silent"]
CMD ["pipeline"]

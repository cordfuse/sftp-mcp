# Multi-stage build for the streamable-HTTP endpoint.
# ssh2's native cpu-features accelerator is optional; we omit it and run ssh2's
# pure-JS crypto, keeping the image free of a native toolchain.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/mcp/package.json packages/mcp/package.json
RUN npm ci --omit=optional
COPY . .
RUN npm run build -w @cordfuse/sftp-mcp

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3901
COPY package.json package-lock.json ./
COPY packages/mcp/package.json packages/mcp/package.json
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY --from=build /app/packages/mcp/dist packages/mcp/dist
EXPOSE 3901
CMD ["node", "packages/mcp/dist/index.js", "--http"]

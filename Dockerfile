# Tilll: one image, one container. Build stage compiles the server and builds the widget and dashboard;
# the final stage holds only what runs.
FROM node:26-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 ships prebuilt binaries; the compiler is only for the day one is missing for this Node.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global pnpm@12.3.4
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:26-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
# The data folder is made here, owned by the unprivileged user, so a named volume mounted on it is writable.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
VOLUME /app/data
# The built widget is a plain file: serving it shows the server is up without asking 1Click or NEAR anything.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/checkout.js').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]

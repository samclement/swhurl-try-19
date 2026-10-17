FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_CONFIG_LOGLEVEL=warn
RUN npm ci

FROM deps AS build
COPY tsconfig.json swhurl.yaml ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM build AS check
# Tests import the compiled app and can read its contracts, migrations and other fixtures.
# .dockerignore keeps local dependencies and dist out, so this preserves the build's output.
COPY . .
RUN npm test --if-present

FROM node:24-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
ARG NPM_CONFIG_LOGLEVEL=warn
RUN npm ci --omit=dev

FROM gcr.io/distroless/nodejs24-debian12:nonroot AS checked-runtime
ENV NODE_ENV=production
# OpenTelemetry: the image turns the SDK on (src/instrumentation.ts); the platform injects where to send it
# (OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_PROTOCOL, OTEL_SERVICE_NAME; make app-new --otlp).
# Logs go to stdout, which the platform collects, so the SDK does not export them too. Resource detectors:
# only local ones; the default list also asks Google Cloud, AWS and Azure metadata servers and logs a
# MetadataLookupWarning at every start.
ENV NODE_OPTIONS="--import /app/dist/instrumentation.js" \
    OTEL_NODE_RESOURCE_DETECTORS=env,host,os,process,serviceinstance,container \
    OTEL_TRACES_EXPORTER=otlp \
    OTEL_METRICS_EXPORTER=otlp \
    OTEL_LOGS_EXPORTER=none \
    PORT=8080
WORKDIR /app
COPY --from=prod-deps --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=prod-deps --chown=65532:65532 /app/package.json ./package.json
# Depending on the check stage makes a failing test stop the runtime image build.
COPY --from=check --chown=65532:65532 /app/dist ./dist
EXPOSE 8080
CMD ["dist/main.js"]

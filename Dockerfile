ARG NODE_VERSION=24.15.0
ARG GO_VERSION=1.27.0

FROM node:${NODE_VERSION}-alpine AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
COPY web/project.inlang ./project.inlang
COPY web/ ./
RUN pnpm install --frozen-lockfile && pnpm build

FROM golang:${GO_VERSION}-alpine AS build
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/build ./web/build
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/pandalibrary ./cmd/pandalibrary \
    && mkdir -p /out/data \
    && chown 65532:65532 /out/data

FROM alpine:3.22 AS certificates
RUN apk add --no-cache ca-certificates

FROM scratch
COPY --from=build /out/pandalibrary /pandalibrary
COPY --from=build --chown=65532:65532 /out/data /data
COPY --from=certificates /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
USER 65532:65532
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["/pandalibrary", "healthcheck"]
ENTRYPOINT ["/pandalibrary"]

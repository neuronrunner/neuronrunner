FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
# Markdown docs from the repository root (docker-compose passes them as the
# "docs" build context). src/app/docs/docs-source.ts reads them from ../docs.
COPY --from=docs . /docs

ARG VITE_API_URL
ARG VITE_GOOGLE_CLIENT_ID
ARG VITE_ENABLE_STUDIO=false
ARG VITE_DOCS_ENABLED=false
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}
ENV VITE_ENABLE_STUDIO=${VITE_ENABLE_STUDIO}
ENV VITE_DOCS_ENABLED=${VITE_DOCS_ENABLED}
RUN npm run build

FROM nginx:alpine AS runner
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80

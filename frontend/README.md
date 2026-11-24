# NeuronRunner Frontend

React 19 + TypeScript + Vite web application for NeuronRunner.

## Development

Use Node.js 22.12+ (the repository pins Node 22).

```sh
npm ci
cp .env.example .env.local
npm run dev
```

The frontend runs at `http://localhost:3000`. Set `VITE_API_URL` to the Django ASGI API origin (normally `http://localhost:8000` during local development).
`VITE_GOOGLE_CLIENT_ID` enables Google sign-in.

All `VITE_*` values are public and embedded at build time. Keep provider keys, OAuth secrets, and database credentials in the backend environment.

## Checks and Production Build

```sh
npm run typecheck
npm test
npm run build
npm run preview
```

- `typecheck` runs TypeScript (`tsc --noEmit`).
- `test` runs each test suite in an isolated Node process.
- `build` compiles the production bundle into `dist/` and pre-renders public entry routes.

## Docker Hosting

The included `Dockerfile` builds the static bundle with Node and serves it with Nginx (including SPA routing fallback):

```sh
docker compose up --build frontend
```

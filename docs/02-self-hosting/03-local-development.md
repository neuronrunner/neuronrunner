---
title: Local Development
description: Run the backend and frontend from source with hot reload.
---

Use this setup when you work on Neuron Runner itself. You still need Docker for sandboxes, and Redis for Channels.

## Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python manage.py migrate
python manage.py createsuperuser
daphne -b 0.0.0.0 -p 8000 app.asgi:application
```

For port previews, run the preview proxy in a second terminal:

```bash
python manage.py run_preview_proxy --host 127.0.0.1 --port 8090
```

## Frontend

```bash
cd frontend
npm ci
cp .env.example .env.local
npm run dev
```

The dev server runs at http://localhost:3000 and talks to `VITE_API_URL` (`http://localhost:8000`).

> [!TIP]
> Set `VITE_DOCS_ENABLED=true` in `frontend/.env.local` to preview these docs at http://localhost:3000/docs while you edit them.

## Tests

```bash
cd backend
python manage.py check
python manage.py test
```

```bash
cd frontend
npm run typecheck
npm test
npm run build
```

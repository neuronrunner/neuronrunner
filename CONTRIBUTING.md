# Contributing to NeuronRunner

Thank you for your interest in contributing to NeuronRunner!

## Getting Started

1. Fork the repository and create a feature branch from `main`.
2. Follow the **Local Development** instructions in [README.md](README.md) to set up the Django backend and React/Vite frontend.
3. Make focused, well-tested changes.

## Running Checks Before Opening a PR

### Backend

```bash
cd backend
python manage.py check
python manage.py test
```

### Frontend

```bash
cd frontend
npm run typecheck
npm test
npm run build
```

## Pull Request Guidelines

- Keep PRs scoped to a single feature, bug fix, or refactor.
- Include unit tests covering new behavior or bug fixes.
- Do not commit secrets, `.env` files, or generated `dist/` build artifacts.
- Ensure all CI checks pass before requesting review.

## License

By contributing to NeuronRunner, you agree that your contributions will be licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)** as specified in [LICENSE](LICENSE).

---
title: Contributing
description: How to propose changes to NeuronRunner and its docs.
---

Contributions are welcome, from typo fixes to new features.

## Workflow

1. Fork the repository and create a branch from `main`.
2. Set up [local development](../02-self-hosting/03-local-development.md).
3. Make a focused change with tests.
4. Run the checks below and open a pull request.

```bash
cd backend && python manage.py check && python manage.py test
```

```bash
cd frontend && npm run typecheck && npm test && npm run build
```

## Pull request guidelines

- Keep each pull request to one feature, fix or refactor.
- Add tests for new behavior and bug fixes.
- Do not commit secrets, `.env` files or `dist/` build output.
- Update the docs when you change behavior or configuration.

## Improving the docs

These pages live in the `docs/` folder of the repository as Markdown files. Each page has an **Edit this page** link that opens it on GitHub. The folder's `README.md` explains the layout, front matter and supported syntax, and how to add a translation.

## License

By contributing, you agree that your contributions are licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).

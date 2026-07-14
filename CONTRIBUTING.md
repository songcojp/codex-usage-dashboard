# Contributing

Thank you for contributing.

1. Fork the repository and create a focused branch.
2. Add or update tests before changing behavior.
3. Run the complete verification set:

```bash
npm ci
npm run check:open-source
npm run typecheck
npm test
npm run build
node --test scripts/*.test.mjs
bash -n scripts/*.sh
```

4. Open a pull request describing the behavior, security/privacy impact, and verification performed.

Do not include real credentials, private hosts, personal filesystem paths, raw prompts, responses, or generated local state. By contributing, you agree that your contribution is licensed under MIT.

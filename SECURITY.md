# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories for this repository. Do not open a public issue containing credentials, exploit details, private infrastructure, or user data.

Include affected versions, impact, reproduction steps, and a minimal proof of concept when possible. Maintainers will acknowledge a complete report as soon as practical and coordinate disclosure after a fix is available.

## Deployment notes

Use HTTPS, strong unique administrator credentials, a random JWT secret of at least 32 characters, exact trusted-proxy configuration, and a protected GitHub production Environment. Never commit `.env` files, device tokens, SSH keys, or database backups.

# Bundled Agent CA Design

## Goal

Make private-HTTPS agent installation automatic by committing the deployment's Caddy root CA certificate to this repository and configuring every installed Linux or Windows agent to trust that certificate without manual operating-system certificate steps.

## Scope and trust model

The repository will contain the public root certificate at `deploy/certs/caddy-root.crt`. A root certificate is public trust material, not a secret. The repository must never contain Caddy's root private key, intermediate private key, server private key, or any other private key.

This repository is intentionally tied to one Caddy private CA. The committed certificate must match the CA stored in the deployment's persistent `codex-usage-dashboard-caddy-data` volume. Replacing that volume or rotating the CA requires replacing the committed certificate and reinstalling every agent.

The agent continues to support publicly trusted HTTPS. Adding the private CA augments Node.js's normal CA set; it does not replace public roots. The agent must never disable TLS verification or accept certificates without hostname or IP validation.

## Repository layout

- `deploy/certs/caddy-root.crt` is the committed PEM-encoded Caddy root CA certificate.
- `scripts/install-agent.sh` locates the bundled certificate at that fixed repository path.
- `scripts/lib/install-agent.sh` stages, installs, backs up, and restores the Linux certificate and generated systemd service.
- `scripts/install-agent-windows.ps1` stages, installs, backs up, and restores the Windows certificate and launcher.
- `scripts/install-agent.test.mjs` verifies certificate validation, generated launch configuration, secret redaction, and rollback behavior.
- `scripts/check-open-source.test.mjs` verifies that the bundled file is a certificate and that no private-key material is admitted.
- `README.md` documents automatic bundled-CA behavior and CA rotation.

## Certificate validation

Both installers must fail before changing the existing installation when the bundled file is missing, unreadable, not PEM encoded, contains private-key material, cannot be parsed by Node's `X509Certificate`, or is not a CA certificate.

The certificate is copied rather than referenced in place so the installed agent does not depend on the repository checkout remaining at the same path. The installed copy is named `server-ca.crt` under the existing protected agent configuration directory. Installation uses restrictive file permissions where the platform supports them.

## Linux installation

The Linux installer stages `server-ca.crt` alongside the staged config and service files. The generated user systemd service sets `NODE_EXTRA_CA_CERTS` to the installed certificate's absolute path before starting Node. Because Node reads `NODE_EXTRA_CA_CERTS` only at process startup, the installer restarts the service during cutover.

The existing transactional workflow expands to include the certificate. Backup preserves the prior installed certificate. Cutover atomically installs the new certificate before starting the new watcher. If cutover or health verification fails, rollback restores the prior certificate or removes it when the previous installation did not have one.

Dry-run output reports the bundled certificate source and installed destination without printing the device token or certificate contents.

## Windows installation

The Windows installer validates and copies the bundled certificate to `%APPDATA%\codex-usage-dashboard-agent\server-ca.crt`.

Because Windows Scheduled Task XML does not provide a direct per-task environment-variable element, the installer creates a protected command launcher in the same configuration directory. The launcher sets `NODE_EXTRA_CA_CERTS` for its child process and then executes the exact Node binary and agent CLI with `watch`. The scheduled task invokes this launcher. It does not modify the user's global environment or the Windows root certificate store.

Backup and rollback include the prior certificate and launcher. Validate-only mode checks the certificate, launcher, and task XML without changing the machine.

## Health verification and errors

Before replacing a healthy installation, each installer performs an HTTPS request to the configured `/api/health` endpoint using the staged CA. A certificate mismatch, hostname mismatch, unreadable certificate, unreachable server, or non-success response aborts installation with a concise error.

After cutover, the existing watcher-start marker check remains in place. A failed post-cutover check triggers the existing rollback path. Neither diagnostic output nor backup metadata may contain the device token.

## Tests

Tests follow red-green-refactor cycles and cover:

- rejection of a missing, malformed, non-CA, or private-key-containing bundled file;
- Linux dry-run output and `NODE_EXTRA_CA_CERTS` service configuration;
- Linux certificate backup, atomic cutover, and rollback;
- Windows launcher environment setup and scheduled-task targeting;
- Windows certificate and launcher backup and rollback;
- preservation of the existing public-HTTPS, token-redaction, watcher-only, and queue-recovery behavior;
- open-source checks that allow the public certificate and continue to reject private keys.

The final verification runs the focused installer tests, the complete script test suite, type checking, and the full repository test suite.

## Operational rotation

CA rotation is an explicit coordinated operation: export the new Caddy root certificate, replace `deploy/certs/caddy-root.crt`, commit it, and reinstall agents while the server presents a chain signed by the new CA. A future dual-root overlap mechanism is outside this change.

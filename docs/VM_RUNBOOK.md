# TMRKZ Operations Runbook

## Daily Operations

### Start the system
```bash
cd /path/to/tmrkz
sh start.sh
```

### Stop the system
```bash
docker compose -p tmrkz stop
```

### Check service health
```bash
sh ops/tmrkzctl.sh status
```

---

## Scheduled Maintenance

### Weekly backup
```bash
sh ops/tmrkzctl.sh backup
```
Backups are stored in `backups/` with SHA-256 manifests.

### Verify backup integrity
```bash
sh ops/verify-restore.sh
```

### Monthly diagnostics
```bash
sh ops/tmrkzctl.sh doctor
sh ops/tmrkzctl.sh inventory > /tmp/monthly-$(date +%Y%m).txt
```

---

## Update Procedure

### Pre-update checklist
1. Verify current system health: `sh ops/tmrkzctl.sh doctor`
2. Confirm backup exists or create one: `sh ops/tmrkzctl.sh backup`
3. Note current schema version: `sh ops/tmrkzctl.sh status`

### Apply update
```bash
sh ops/tmrkzctl.sh update /path/to/TMRKZ_UPDATE.tar.gz
```

The update command automatically:
- Validates the bundle (no path traversal, no forbidden content)
- Creates a pre-update backup
- Stops build watchers
- Stages updated files
- Restarts affected services
- Waits for health checks

### Post-update verification
```bash
sh ops/tmrkzctl.sh doctor
sh ops/tmrkzctl.sh verify
```

### Rollback if needed
```bash
ls backups/pre-update-*
sh ops/tmrkzctl.sh rollback backups/pre-update-YYYYMMDDTHHMMSSZ
```

---

## TLS Certificate Management

### Generate CSR
```bash
sh ops/tls/make-csr.sh
```
Submit the CSR to your certificate authority.

### Install signed certificate
```bash
sh ops/tls/install-cert.sh /path/to/cert.pem
```

### Enable HTTPS
```bash
sh ops/tls/enable.sh
```

### Check certificate status
The Management Center (Settings → System Management) shows certificate subject, issuer, expiry, and SAN. Or via CLI:
```bash
sh ops/tmrkzctl.sh doctor | grep -A5 TLS
```

---

## Troubleshooting

### Services won't start

1. Check Docker is running:
   ```bash
   docker info
   ```
2. Check images are loaded:
   ```bash
   docker images | grep tmrkz
   ```
   If missing: `docker load -i tmrkz-images.tar`
3. Check port availability:
   ```bash
   sh ops/tmrkzctl.sh doctor | grep port
   ```
4. Check disk space:
   ```bash
   df -h .
   ```

### Backend not responding

```bash
docker compose -p tmrkz logs backend --tail=200
docker compose -p tmrkz restart backend
```

Wait 30 seconds for startup, then verify:
```bash
curl -sf http://localhost:8088/api/v1/health
```

### Database issues

```bash
# Check database container
docker compose -p tmrkz logs db --tail=100

# Check connectivity
docker compose -p tmrkz exec db pg_isready -U tmrkz

# Check schema version
docker compose -p tmrkz exec db psql -U tmrkz -c \
  "SELECT version FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT 1;"
```

### Keycloak not responding

```bash
docker compose -p tmrkz logs keycloak --tail=100
docker compose -p tmrkz restart keycloak
```

### Frontend not loading

```bash
# Rebuild frontend
docker compose -p tmrkz restart web-build
docker compose -p tmrkz logs web-build --follow
# Wait for "build ready"

# Check nginx
docker compose -p tmrkz logs web --tail=50
```

### Map tiles not rendering

1. Check map packages exist:
   ```bash
   ls -la map-packages/
   ```
2. Verify checksums:
   ```bash
   sh ops/tmrkzctl.sh doctor | grep map
   ```
3. Check map tile server:
   ```bash
   docker compose -p tmrkz logs tileserver --tail=50
   ```

### LDAP connection fails

1. Verify network connectivity to LDAP server from the Docker host.
2. If using internal CA, ensure the CA certificate is installed in the truststore.
3. Check Settings → Integration Settings → LDAP for correct configuration.
4. Test with `ldapsearch` from the host if available.

### Embedding (iframe) blocked

1. In Settings → System Management → Embedding, add the origin (`https://host[:port]`).
2. Save and verify the browser console no longer shows `frame-ancestors` violations.

---

## Recovery Procedures

### Full restore from backup
```bash
sh ops/tmrkzctl.sh rollback backups/tmrkz-YYYYMMDDTHHMMSSZ
```

### Rebuild from source directory
If the installation is corrupted but source files are intact:
```bash
docker compose -p tmrkz down
docker compose -p tmrkz up -d --build
```

### Emergency reset
If all else fails and you have a clean backup:
```bash
docker compose -p tmrkz down -v          # WARNING: destroys all data
docker compose -p tmrkz up -d --build
sh ops/tmrkzctl.sh rollback backups/<latest-backup>
```

---

## Diagnostic Collection

To share diagnostics with support (no secrets included):
```bash
sh ops/tmrkzctl.sh inventory > diagnostic.txt
```

For detailed service logs:
```bash
docker compose -p tmrkz logs --since=1h > service-logs.txt 2>&1
```

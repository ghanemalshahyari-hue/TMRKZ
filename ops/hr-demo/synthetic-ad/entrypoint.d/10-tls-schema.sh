#!/bin/sh
# TMRKZ synthetic enterprise directory (profile synthetic-enterprise; owner, 20 Nov 2026; ADR-094), as MOVER's test directory
# (mover-state/test-ldap/entrypoint.d/10-mover-tls.sh): our own CA-signed certificate for LDAPS, and schema updates allowed
# so up.sh can add the Mil* attributes to the User class. Runs before samba starts (smblds entrypoint.d).
set -e
mkdir -p /var/lib/samba/private/tls-tmrkz
cp /tls/server.crt /tls/server.key /tls/ca.crt /var/lib/samba/private/tls-tmrkz/
chmod 600 /var/lib/samba/private/tls-tmrkz/server.key
if ! grep -q "tls-tmrkz" /etc/samba/smb.conf; then
  sed -e '/^\[global\]/a\\ttls enabled = yes\n\ttls keyfile = /var/lib/samba/private/tls-tmrkz/server.key\n\ttls certfile = /var/lib/samba/private/tls-tmrkz/server.crt\n\ttls cafile = /var/lib/samba/private/tls-tmrkz/ca.crt\n\tdsdb:schema update allowed = true' -i /etc/samba/smb.conf
fi

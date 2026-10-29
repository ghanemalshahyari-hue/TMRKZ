# Trusted certificate authorities for the identity provider

Place the organisation's CA certificates (PEM, `*.pem` or `*.crt`) here before starting Keycloak. Keycloak trusts them
for LDAPS/StartTLS to the directory (`KC_TRUSTSTORE_PATHS`). Certificate validation is never switched off; a directory
whose certificate does not chain to a CA in this folder is refused. Do not commit private keys.

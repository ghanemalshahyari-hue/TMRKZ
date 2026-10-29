# TMRKZ identity provider: Keycloak with the TMRKZ sign-in theme and realm baked into the image (build context: repo root).
# The theme is part of the image, so nothing is changed inside a running container; upgrading Keycloak means rebuilding
# this file on a newer pinned tag and re-running the acceptance environment.
FROM quay.io/keycloak/keycloak:26.7.5 AS build
ENV KC_DB=postgres \
    KC_HEALTH_ENABLED=true \
    KC_HTTP_RELATIVE_PATH=/auth
COPY ops/keycloak/themes/tmrkz /opt/keycloak/themes/tmrkz
RUN /opt/keycloak/bin/kc.sh build

FROM quay.io/keycloak/keycloak:26.7.5
COPY --from=build /opt/keycloak/ /opt/keycloak/
COPY ops/keycloak/realm/tmrkz-realm.json /opt/keycloak/data/import/tmrkz-realm.json
USER 1000
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
# --import-realm creates the realm on first start only; an existing realm is never overwritten.
CMD ["start", "--optimized", "--import-realm"]

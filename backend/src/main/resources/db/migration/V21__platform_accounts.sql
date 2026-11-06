-- V21: the two lasting platform accounts of an installation (owner decision of 6 Nov 2026): «admin» (super
-- administrator) and «developer». They are local accounts of the identity provider (Keycloak users holding the realm
-- role tmrkz-platform, created by ops/platform-accounts.sh with passwords from the installation's .env), not directory
-- or HR people. Their first sign-in creates a LOCAL person with lasting grants; the HR projection only ever changes
-- HR people, so connecting the directory or the HR source never disables them. The link records how it was made.
alter table identity_link drop constraint identity_link_method_check;
alter table identity_link add constraint identity_link_method_check
  check (method in ('ENTERPRISE_KEY', 'ADMINISTRATOR', 'BOOTSTRAP', 'PLATFORM'));

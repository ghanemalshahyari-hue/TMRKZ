# TMRKZ ↔ MOVER — administrative integration contract (draft)

Status: proposed contract, 30 October 2026. **Not implemented.** No endpoint, queue or account described here exists
yet in either application. This document fixes what may be exchanged so that a later implementation stays inside the
administrative scope.

## 1. Scope

In scope — administrative facts only:

- stable identifiers of organisations and people, so both applications refer to the same body and person;
- cross-references between an administrative request in TMRKZ and a record in MOVER that cites it;
- an authorised link to a TMRKZ request's status page or approved document;
- minimal administrative notifications (a request was submitted, decided, communicated, closed).

Out of scope, and not to be added through this contract: operational movement, routing or deployment; positioning or
placement of units or formations; tactical overlays; terrain suitability; operational tracking; merging the two
databases; and granting access in one application because a person can use the other.

## 2. Identifiers

| Item | Identifier | Source of truth | Notes |
|---|---|---|---|
| Organisation | TMRKZ `organization.id` (UUID) plus the HR source key held in `organization.source_external_id` | the read-only HR mirror (TNQL contract, ADR-014) | The HR key is shown only to authorised administrators; exchanges use it only between the two systems' services. |
| Person | TMRKZ `person.id` (UUID) plus the HR employee number | HR mirror | Directory account names are not identifiers for exchange. |
| Facility / site | TMRKZ `site.id` (UUID) and `site.code` | TMRKZ facilities register | Geometry is not exchanged by this contract. |
| Request | TMRKZ `request.id` (UUID) and the reference number (`MV-YYYY-NNNN`) | TMRKZ | The reference number never changes across corrections and resubmissions. |
| Approved document | `(request.id, revision, sha256)` | TMRKZ approval document | A link points to a revision; it never points to "latest". |

Both systems must map identifiers through the HR keys. Neither creates organisations or people in the other.

## 3. Messages (minimal notifications)

One message type, delivered by the TMRKZ transactional outbox (the same mechanism used for internal notifications):

```json
{
  "type": "ADMIN_REQUEST_EVENT",
  "event": "SUBMITTED | RETURNED | REFERRED | APPROVED | REJECTED | COMMUNICATED | CLOSED",
  "requestId": "uuid",
  "reference": "MV-2026-0159",
  "revision": 2,
  "requestingOrganisation": { "id": "uuid", "hrKey": "…" },
  "occurredAt": "2026-10-30T09:15:00Z",
  "statusLink": "https://<tmrkz-host>/#requests/<requestId>",
  "document": { "revision": 2, "sha256": "…" }
}
```

- No request content (reason, attachments, form values, occupants, people) is included. The recipient follows
  `statusLink` and TMRKZ applies its own authorisation to whoever opens it.
- `document` is present only for `APPROVED`, `COMMUNICATED` and `CLOSED`.
- Delivery is at least once; the consumer de-duplicates on `(requestId, event, revision, occurredAt)`.
- Messages leave the isolated network only through a channel the institution approves; none is configured today.

## 4. Cross-references

MOVER may store a TMRKZ reference (`requestId`, `reference`) against its own record. TMRKZ may store an opaque MOVER
reference in a future, explicitly added field on the request. Neither side derives permissions from the other's
reference. A reference is not a booking: only TMRKZ's final approval creates a reservation.

## 5. Authorisation

- Service-to-service calls use a dedicated service identity per direction, issued by the institution's identity
  provider, with only the scopes needed (TMRKZ: `admin-events:publish`; MOVER: `admin-events:consume`).
- A person opening a TMRKZ link signs in to TMRKZ (Keycloak + LDAP) and sees only what their TMRKZ grants allow,
  evaluated on the server with OpenFGA as co-decider.
- Access to MOVER never implies access to TMRKZ content, and the reverse.

## 6. Open decisions for the institution

| Decision | Needed for |
|---|---|
| Transport between the two systems (internal message broker, HTTPS webhook inside the network, or file drop) | §3 delivery |
| Service identities and their issuance | §5 |
| Whether MOVER should receive `RETURNED` and `REFERRED`, or only final outcomes | §3 event list |
| Retention of exchanged messages on each side | operations |

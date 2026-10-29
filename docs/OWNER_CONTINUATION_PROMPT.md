# TMRKZ — owner continuation prompt: finish the interaction and prove readiness

Date: 29 October 2026. Reviewed source baseline: `7f844dcc955153796724ba9039c343cf2ea455a0` on `main`.

Paste this document into the implementation session, or instruct the agent to read and execute it. It is an implementation brief, not a statement that the work has already been completed.

## 1. Assignment and scope

Continue the existing TMRKZ application. Implement the remaining administrative facilities experience and the release work below. Work through meaningful pieces autonomously. Deliver working UI and server behaviour, not another plan or a report consisting only of test counts.

The owner's central complaint is valid: the intended direct interaction with a site has not been delivered as an on-site menu. The source currently binds a marker/boundary click to selection, and displays temporary/open-ended request buttons in the side panel. Do not describe that as an implemented contextual menu.

This brief covers facilities, administrative use requests, site/resource geometry, organisational identity, access, approvals, signatures and isolated deployment. The supported two-option interaction below is **temporary administrative use / open-ended administrative use**. It is not the owner's original military repositioning/deployment workflow. Do not silently rename these administrative requests or claim that moving units, choosing deployment positions, terrain suitability or operational distance rules have been implemented. Those capabilities remain outside this brief.

Authoritative existing requirements remain in `docs/ADMIN_PRODUCTION_IMPLEMENTATION_PROMPT_AR.md` and `docs/MAP_WORKSPACE_COMPLETION_AR.md`. Preserve their decisions and scope. This prompt makes the administrative interaction explicit and closes the outstanding work; it does not discard earlier accepted features.

## 2. Read the current application before editing

Read `CLAUDE.md`, the two briefs above, `docs/STATUS.md`, `docs/TRACEABILITY.md`, `docs/TNQL_COMPATIBILITY.md`, and ADR-015 through ADR-020. Inspect the current branch and working changes rather than assuming this baseline is still the latest.

Relevant implementation entry points at the reviewed baseline:

- `frontend/src/pages/MapPage.tsx`: site selection and request prefilling.
- `frontend/src/components/map/MapCanvas.tsx`: boundary and marker click handlers call `onSelect`; no on-site action menu is wired here.
- `frontend/src/components/map/SiteDetailPanel.tsx`: existing `NEW` actions for temporary/open-ended use.
- `frontend/src/components/map/BoundaryEditor.tsx`: administrative site-boundary editing, separate from requesting use.

Inspect the current types/services before choosing additional filenames or endpoints. Reuse the existing map, request, authorisation, workflow and signature services.

Keep `main`, one working copy, and all uncommitted work. Coordinate files touched by another active session. Do not create branches/worktrees, reset, stash, erase volumes, overwrite other sessions' work, or touch TNQL's runtime/database. Use the owner's existing commit/push authorisation and repository checks; preserve unrelated changes. Do not publish externally or deploy to a real enterprise host from this instruction alone.

## 3. First deliverable: clicking a site opens two clear actions on the map

Implement this before spending more time on secondary studio features.

1. A single left click or tap on an authorised site marker **or its real boundary** selects it and opens a compact anchored menu near the click/marker. Preserve the side panel as an equivalent accessible path.
2. The primary actions are `طلب استخدام مؤقت` and `طلب استخدام مفتوح المدة`. A two-segment circular treatment is acceptable on desktop if labels fit. On small screens use two labelled buttons in a popover/bottom sheet. Usability takes priority over a perfect circle.
3. The menu shows the selected site's name. It follows the correct site while panning, stays within the map viewport, and closes on Escape, outside click, changing selection or opening the chosen action. Clicking a button must not bubble into selecting a different feature or reopening the menu.
4. Make it work with keyboard focus, Enter/Space, Escape and touch. Opening the menu must not require right click, hovering, a long press or pixel-perfect dragging.
5. The actions come from the published request-type configuration and the actor's scoped rights. Pass the **selected request type code** into the request flow; do not let the wizard silently choose the first available type. Open-ended use appears only when the published type permits it. Explain unavailable actions and how to fix missing selection; hide actions that would reveal a forbidden resource.
6. An action opens the existing request drawer, prefilled with the selected organisation, site, resource IDs, period and type. If a site has several resources, ask which resource(s) in the drawer. Do not silently claim the whole parent merely because the parent was clicked.
7. Selection is never a write operation. Opening/closing a menu must not create requests, reservations or geometry records.
8. From the organisation tree and site tree, users can open the same actions without hunting for a second implementation. All entry paths use the same command handler and backend checks.

Finish this vertical slice, start the updated acceptance app at `http://localhost:8088`, and provide a short click path to the owner. Continue the remaining work without waiting for a response, unless a real dependency prevents it. Do not claim to have operated the owner's own browser if only an automation browser was controlled.

## 4. Map selection and drawing must have explicit meanings

There are two administrative modes:

- **Requesting use:** choose an existing site and registered sub-area/resource on the map, then specify the administrative period. Multi-select is allowed only where the published request type allows it. An authorised resource's visible boundary is selected as a whole; the UI shows exactly what is being requested.
- **Editing the site register:** a separately authorised facilities user opens `تحرير سجل الموقع — الحدود`, draws/edits the site's registered boundary, validates it, then explicitly saves a new version or cancels. Keep this mode visually distinct from the request drawer.

Provide vertex editing and coordinate entry alongside drawing; keep undo/cancel available. Dragging the map pans it. Selecting a different site during editing must not redirect the eventual save to that other site. If an editor already binds its target safely, preserve that fix.

Do not drag a camp footprint or a unit symbol to a new deployment location. Do not make a request user's drawing rewrite the source site's official geometry. Do not present missing geometry as a generated polygon. Any future administrative sub-area must first become an authorised, validated resource with an explicit policy; a sketch alone is not an approved exclusive booking.

Preserve the stable source location and each request revision's reviewed geometry version. Published approvals and signed documents remain unchanged after site-register edits.

## 5. Complete the ordinary map experience

- Keep organisation and facility trees independent in data, linked by dated responsibilities and use records. Support organisation-only, organisation plus descendants, and explicit scope sets according to grants.
- Allow entry from either the tree or the map. Show main sites without a parent, registered child areas and the current breadcrumb. Search all authorised descendants while loading results progressively.
- Preserve selection, zoom and draft input when opening/minimising the request drawer. Warn before applying a different site/resource selection to an edited draft. Cancel must not leave a hidden reservation.
- Show days, hours and open-ended periods with clear institution-local time; keep the existing half-open time contract. The server decides the availability for those resources and that period.
- Keep pending requests orange without reserving a resource. Explain partial occupancy for shared facilities. A booked independent child must not mark every other resource as unavailable. Default shared use has no headcount limit.
- Keep approved-request state separate from availability. Colour has text and an icon. Loading/error/unknown is visibly distinct from available. Late network responses must not restore an old selection or old permissions.
- Reuse configured parent/child blocking and optional simultaneous-use limits. Final approval checks and reservation writes remain atomic and idempotent; a front-end green colour is never proof of a reservation.
- Keep the site name, selected resources, period and request type visible before submission. Support review, return with reason, correction, approval, information copies, administrative handover/receipt and closure through the existing configurable workflow.

## 6. Implement the requested informational unit symbols

Implement section 10 of `docs/MAP_WORKSPACE_COMPLETION_AR.md`; writing the requirement into documentation does not complete it.

- Bundle the open-source `milsymbol` renderer locally, pin a compatible published version, preserve its MIT notice, and record its supported standard/version. Do not copy commercial generator extensions as though they were part of the MIT package.
- Use one reusable symbol component in the organisation tree, unit detail cards, request organisation summaries and the authorised organisation details beside the map, plus an Arabic legend.
- Store approved symbol assignments as local metadata linked to stable organisation IDs. HR refreshes must preserve them. Do not infer military unit size/type from an administrative HR level number or from a name.
- A permitted administrator selects an approved symbol with a preview. Missing assignments use a clearly labelled generic organisation icon; do not guess.
- Keep standard symbol colours separate from administrative availability badges. Retain the Arabic name and accessible description. Do not replace facility geometry with a unit identity symbol.

## 7. Deliver useful offline backgrounds, with an honest coverage contract

Current status documents SVG and georeferenced PNG/JPEG overlays. PMTiles, MBTiles and XYZ are currently refused. A regional overlay is not unlimited global offline coverage, and a disabled aerial button is not an implemented aerial source.

Keep those working formats. Add **one documented, tested tiled-background path** suitable for licensed local packages and the existing Leaflet application. Inspect compatible open-source readers/servers and primary documentation, select the implementation, and record the format/profile in an ADR before wiring it. Keep it self-hosted; do not introduce a cloud dependency or replace the entire map engine without a concrete need. Do not claim all archive, raster and vector formats are supported because one adapter works.

Requirements:

- Roads/base cartography, licensed aerial imagery and georeferenced facility plans are selectable when their packages exist. The manager supports preview, activate/deactivate, attribution, source, licence, date, CRS, extent, zoom coverage, version and checksum.
- Demonstrate two actually different installed backgrounds using lawful non-sensitive acceptance data. Do not fabricate satellite imagery. If enterprise imagery is absent, say so and leave that connection/data acceptance pending.
- Determine coverage from the selected package and viewport/zoom. Support partial coverage and zoom limits; do not treat any installed package as coverage for every place.
- Serve packages and symbols/fonts/conversion assets over the internal network. Verify the chosen tiled path's addressing, coordinate orientation, content types, caching and archive access behaviour. Do not extract unrestricted archives or accept arbitrary remote URLs.
- Keep overlay visibility/opacity independent from background selection and name visibility. Sensitive overlays are filtered on the server rather than downloaded and hidden in React.
- Retain real GIS import and geometry history. Advertise only verified input formats and CRS; never guess an unspecified coordinate system. Report the institution's CRS decision as pending when it is unknown.

## 8. Finish access management without widening authority

Preserve independent VIEW/summary, CREATE, EDIT, REVIEW, APPROVE, EXPORT, EXECUTE, facility administration, access administration, configuration and audit actions. Configuration access alone does not expose request content or grant approval. Requesters may approve their own request only under the existing explicit stage/action/scope rules; preserve the requester marker.

Finish these previously reported omissions as separate, bounded features:

1. **Scoped explicit denies:** add versioned deny policies with action, target, scope and validity. Default remains denial when no allow exists; an applicable explicit deny overrides an allow only within its own defined action and scope. Preview/explain must show the exact reason. Apply the same policy to point decisions, list/search/count/export/attachments and relevant background tasks; do not implement a UI-only blacklist. Test the migrated additive baseline remains unchanged when no deny is configured. Keep OpenFGA model/version and local evaluation consistent; unavailable/stale decisions must not fail open.
2. **Delegations inside the permissions studio:** reuse existing records and semantics. Create, inspect, end/revoke and audit dated delegations with role/action and scope limits. Neither delegator nor access manager may grant more than their own grantable authority. Preserve task realignment and immediate revocation.
3. **Finish progressive loading:** move the organisation page and request-form organisation selector to the existing lazy/search endpoints. Do not download 200,000 people, and do not mistake 7,000 organisations for the number of map sites.

Publishing, rollback and explanation remain based on immutable policy versions. Do not make tests pass by granting administrator-wide content rights. Do not add a new deny feature and leave list/count or background-job behaviour using an older, incompatible predicate.

## 9. Add an explicit migration action for running administrative requests

Keep existing requests on their original form/workflow versions by default. Add a separately authorised migration action for eligible **unfinished** requests; approved, closed and signed revisions remain immutable.

- Preview the old/new form and workflow versions, field mapping, missing required values, changed conditions, pending tasks and approvals that will be invalidated. Refuse an incompatible mapping with actionable errors.
- Require a reason and an expected request revision. Re-check the actor and the request under lock on commit. Persist a migration record and the before/after version references.
- Preserve the earlier request revisions and decisions as history. Use the existing change-impact rules to decide which approvals must restart; never preserve an approval under meaningfully changed criteria without an explicit valid policy.
- Replace/cancel old pending workflow tasks coherently, prevent two active workflow instances or duplicate notifications, and make retry idempotent. A failure leaves the previous running version usable.
- Show the user what changed and who performed it. Do not silently bulk-migrate all requests when a form or workflow is published.

## 10. Finish certificate signing and the document experience

Preserve the working signature/seal mechanism and its transaction separation. The report describes DSS/JAdES with a fictional PKI; do not advertise the enterprise provider or qualified/legal assurance as connected.

- Run the final complete browser journey with the configured **test PKI**: approver authentication/step-up, signature, separate organisation seal, publication only with the committed decision/reservation, and verification/download afterwards. Switching back to internal attestation must not be used as proof of the certificate journey.
- Show document contents, person signer, organisation seal, signed revision/hash, verification outcome/time and certificate validity information that the actor may see. A visual signature image or stamp alone is not cryptographic evidence. Make the downloadable signed payload and readable approval document discoverable; label exactly what format was signed.
- A revoked/expired/untrusted certificate, unavailable provider, missing required revocation evidence or mandatory time-stamp service must produce the correct explicit refusal/pending state. No silent fallback from required PKI to internal attestation.
- Preserve unpublished attempts after a transaction conflict without exposing them as approved documents or reservations. Retrying must not publish a stale payload or duplicate decision.
- Complete configuration validation and the production provider adapter where the approved provider interface is known. Keep actual provider endpoints, credentials, keys, certificate material, CRL/TSA setup and institutional assurance assessment as specific external dependencies until supplied and verified locally. Never commit them or ask for private keys in chat.

Use one application/runtime configuration model. The isolated fictional acceptance stack is legitimate test infrastructure, not a second product/demo application. A real deployment configured to require PKI cannot bypass that policy because the acceptance environment uses test certificates.

## 11. Preserve the TNQL-compatible HR and identity contract

Do not redesign the completed HR/authentication path to speed up UI work.

- Oracle remains read-only, using the approved TNQL-compatible view/column contract and hourly staged publication with empty/drop protection and single-run coordination.
- Original HR fields remain authoritative, with local metadata separated. Stable source identifiers are visible only to appropriately authorised administrators/developers.
- Directory identity linking, ambiguity review, LDAP TLS verification, required OIDC authentication time, fresh approval authentication, first-administrator bootstrap, ended grants and task reassignment must remain intact.
- Real institution values are configured locally through supported mechanisms. Reuse the reviewed TNQL deployment/configuration conventions where applicable, with TMRKZ's own keys, stores, ports and volumes. Do not copy encrypted ciphertext under a different key and assume it works.
- Diagnose not-connected components honestly. Missing real Oracle/LDAP/PKI details do not block independent UI, migration, bundle or load work; they do block a claim of enterprise integration readiness.

## 12. Step 7: one complete journey driven through the UI

Use the running acceptance stack at `http://localhost:8088`, with fictional data and the directory-backed sign-in paths. Each persona signs in normally. Do not inject cookies/roles, switch users through a demo control, or invoke transition APIs as a substitute for the UI journey.

Fixture provisioning may run before the scenario and must be documented separately. Once the scenario begins, navigate, select, create, return, edit, approve/sign, hand over and close through visible controls only. Observe resulting APIs/database state for verification without using observation to perform missing UI actions.

Journey:

1. Sign in as requester; choose an organisation/site from its allowed tree.
2. Click the site on the map; show the two-action menu. Choose temporary use, select a registered resource and period, save/edit the drawer, minimise/reopen, submit.
3. Sign in as reviewer, return with a reason; requester corrects and resubmits.
4. Review/approve through the configured stages, using test certificate signing and the organisation seal at the applicable stage. Confirm the booking and the pinned geometry/document version.
5. Check the permitted information-copy recipient, a summary-only viewer, and a person outside scope without changing grants to manufacture success.
6. Complete the configured administrative execution/receipt/closure actions. Open the signed document and verify it again.
7. Exercise open-ended use through the second action, and one configured change/termination path. Reuse already-passed concurrency tests unless booking logic changed.

Capture concise evidence of the actual UI, browser errors/external network requests and result. Keep screenshots small and purposeful. Do not take screenshots of passwords, connection strings or real personnel data.

## 13. Close the unexplained Node failure sensibly

The owner report says one journey run crashed, its Node error was truncated, and three later runs passed. Preserve that history. Do not call the cause fixed solely because a later run passed.

Capture complete stdout/stderr, exit code, environment/runtime versions and failure context on the next relevant journey run. Add bounded process diagnostics and retain the failure artefact without leaking secrets. Fix a reproducible harness defect if found; do not swallow the exception or loop until one run turns green. Do not keep rerunning the suite merely to chase an unreproduced failure. A residual unreproduced flake must remain disclosed with the successful-run evidence.

## 14. Measure representative load once the features stabilise

Generate approximately 7,000 fictional organisations and 200,000 fictional people in the acceptance database only. Keep all enterprise sources read-only and untouched. Declare the map-site, geometry, request, reservation and attachment counts separately.

Use a realistic mix of scoped tree/search, map viewport queries, availability, request writes and review/approval. Include OpenFGA and normal server-side authorisation; do not benchmark a bypass endpoint and call it application capacity. Treat certificate-provider latency separately when the provider differs from production.

Run one bounded measurement sequence with 20 then 50 concurrent users, warm-up and fixed measurement durations. Record hardware, service versions, dataset, mix, duration, P50/P95/P99, throughput, unexpected errors, queues, CPU, RAM and database contention. Define any provisional latency/error targets before measurement and label them as assumptions rather than owner-approved SLAs. Report failures against them rather than weakening them after the run.

Use the results to fix material bottlenecks. Repeat only the affected measurement when a change or failure justifies it. A brief load probe does not prove long-term availability, failover or an unstated recovery objective.

## 15. Finish the isolated release bundle and restore path

Produce one versioned release bundle with pinned image digests, source/release revision, manifests/checksums, Compose definitions, migrations, local frontend/map/font/symbol assets, licence inventory and operating instructions. Prepare images/dependencies on the permitted connected build host; the isolated target must not need internet, package installation, image pulls or an external CDN at start-up.

On a clean isolated acceptance target:

- Load the bundle, configure local test institution settings, start with no external egress, and execute the final UI journey against that build.
- Verify a clean first-administrator/first-HR-source setup without relying on preseeded business administrator records. Keep bootstrap auditable and limited.
- Test upgrade from the current supported release using a verified backup. Preserve original records and documents. State the supported rollback method; do not attempt destructive down-migrations on the owner's runtime data.
- Restore business, identity and authorisation databases, attachments, maps and the required configuration/key references into a clean stack. The pending OpenFGA dump restore must be tested end to end. Verify rights, identities, models/tuples, request history and signed documents after restore, not just row counts.
- Separate migration ownership from the application's runtime database role. Confirm runtime operations still work with restricted rights; provision PostGIS through the migration/operator role rather than granting schema ownership back to the app.
- Verify internal TLS/trust and secret handling for the target deployment. Test acceptance-network blocking and document the distinct host/network controls the enterprise operator must verify.

Do not invent production RPO/RTO, high-availability or certificate trust guarantees. Record measured recovery time and outstanding institutional targets as such. Keep the last working stack and volumes until the tested upgrade/restore method is concrete.

## 16. Testing cadence: focused during work, full at the final checkpoint

The owner is concerned about time. Respect this instruction throughout:

- Complete one meaningful piece, then run only its relevant tests and build checks. Use current targeted backend-class/browser entry points where available.
- Reuse the existing MAP-01…MAP-18 coverage and extend the relevant cases for the contextual menu and symbols instead of creating a parallel duplicate suite.
- Styling, wording, icon or screenshot changes do not automatically require rerunning HR, LDAP, restore, scale and every other suite.
- Immediately test changes to rights, data integrity, signatures, workflow migration and reservation concurrency in their affected paths.
- Perform the complete required integration checks once the release candidate is stable. Further runs need a changed dependency, a failure or a concrete unresolved concern. Required repository gates still apply.
- Reuse an existing service/test environment when safe; avoid repeated image builds when no image inputs changed. Rebuild/start the runtime actually being reviewed when its code did change.
- Report actual durations and reasons for retries. A command's maximum timeout is not its observed duration. Do not add tests that merely mirror implementation or multiply test counts without useful coverage.

## 17. Execution order and completion report

Work in this order:

1. On-site two-action menu and correct drawer/type/resource handoff; expose the working result for owner review.
2. Informational symbols, missing map-source support and the remaining progressive selectors.
3. Studio deny/delegation completion and governed running-request migration.
4. PKI document journey and any resulting integration corrections.
5. Clean offline bundle/upgrade/restore, then representative load, then one final consolidated acceptance checkpoint.

Keep `docs/STATUS.md`, `docs/TRACEABILITY.md`, ADRs and OpenAPI current as behaviour changes. Reconcile old statements/counts with current evidence; do not erase the history of a failed or partial check.

The final report must provide:

- Exact revision and the runtime/build revision available at port 8088.
- What the owner now sees on clicking a site, and a short click path for the menu, drawing/editor, symbols, request, review and signed document.
- A requirement-to-evidence table: implemented and verified, implemented but awaiting enterprise acceptance, blocked by an identified external dependency, or not implemented. Do not mark external-provider tests as production-connected.
- Commands and actual results for the affected checks and the final checkpoint, including residual flakes.
- Bundle path/checksum, upgrade/restore evidence, observed load results and deployment limitations.
- A concise list of institution inputs still required, specifying field/type or approved local configuration channel only, never publishing secrets.

Do not end after finishing another isolated studio while leaving the primary map interaction pending. Do not stop merely to ask whether to continue the next independent item. Do not state that every original requirement or the real enterprise deployment is ready while any excluded workflow, missing data/provider or unverified target condition remains.

## 18. Source references

Reviewed application source and status, pinned to avoid ambiguity:

- Map click behaviour: https://github.com/ghanemalshahyari-hue/TMRKZ/blob/7f844dcc955153796724ba9039c343cf2ea455a0/frontend/src/components/map/MapCanvas.tsx
- Existing side-panel actions: https://github.com/ghanemalshahyari-hue/TMRKZ/blob/7f844dcc955153796724ba9039c343cf2ea455a0/frontend/src/components/map/SiteDetailPanel.tsx
- Selection/request handoff: https://github.com/ghanemalshahyari-hue/TMRKZ/blob/7f844dcc955153796724ba9039c343cf2ea455a0/frontend/src/pages/MapPage.tsx
- Current delivery limits: https://github.com/ghanemalshahyari-hue/TMRKZ/blob/7f844dcc955153796724ba9039c343cf2ea455a0/docs/STATUS.md
- Current acceptance matrix: https://github.com/ghanemalshahyari-hue/TMRKZ/blob/7f844dcc955153796724ba9039c343cf2ea455a0/docs/TRACEABILITY.md
- Symbol renderer's source, licence and supported features: https://github.com/spatialillusions/milsymbol

Use the current primary documentation of any dependency you add. These links establish the reviewed baseline; the implementation session must inspect newer work and preserve it.

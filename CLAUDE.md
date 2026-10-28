# TMRKZ implementation entry point

This repository is the initial concept and complete administrative handoff. Its prototype working name is MOVER.

Read, in order:
1. `handoff/START_HERE.md`
2. `handoff/CLAUDE_BUILD_PROMPT.md`
3. `handoff/DECISIONS.md`
4. `handoff/REQUIREMENTS.md`
5. `handoff/ARCHITECTURE.md`
6. `handoff/DATA_MODEL.md`
7. `handoff/API_CONTRACT.md`
8. `handoff/ACCEPTANCE_TESTS.md`
9. `handoff/SOURCES.md` and `handoff/PROTOTYPE_VERIFICATION.md`

Inspect `dist/prototype.html` and the editable sources under `unified/`. `handoff/` holds the authoritative specifications; `dist/handoff/` is a generated copy. The five previous designs remain as references in `dist/`.

Follow `handoff/CLAUDE_BUILD_PROMPT.md` for phased implementation. Preserve the existing prototype and documentation while adding production application modules in clearly named directories. Record decisions, keep requirement-to-test traceability, and explicitly report unimplemented items.

Build generic administrative facilities, reservations, identity, permissions, forms, approval workflows, audit, and offline deployment. Exclude military deployment optimization, tactical positioning, and operational recommendations. Do not solicit actual sensitive locations for demo data.

The local role picker and signature demonstration are not production authentication or PKI. Real authorization belongs on every server operation, and final booking confirmation must enforce atomic conflict prevention. Do not claim readiness from screenshots or mock data alone.

Do not rely on a cloud service or Vercel for the isolated production deployment. Use stable compatible dependency versions, retain third-party attribution, and keep secrets out of source control.

Start implementation from the recorded assumptions and open decisions without repeating the original questionnaire.

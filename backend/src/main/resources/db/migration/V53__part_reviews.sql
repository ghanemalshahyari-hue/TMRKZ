-- «الاعتماد الجزئي» (owner brief §6, phase 8; ADR-090): what each stage decided on each part of a request (the new site, the
-- main and the sub deployment area), with each part's fingerprint when decided: stage key -> part -> decision. A part a stage
-- approved and that has not changed since is kept when the request comes back to that stage.
alter table restationing_request add column part_reviews jsonb not null default '{}'::jsonb;

-- «إرشادات صفحة الدخول» kept by the administrator in the settings (owner, 17 Nov 2026; ADR-083): one board, shown on the
-- sign-in page before anyone signs in (only the notes shown today leave the server there). No row: the page's own notes.
create table sign_in_board (
  id          smallint primary key default 1 check (id = 1),
  board       jsonb not null,
  updated_by  uuid not null references person(id),
  updated_at  timestamptz not null default now()
);

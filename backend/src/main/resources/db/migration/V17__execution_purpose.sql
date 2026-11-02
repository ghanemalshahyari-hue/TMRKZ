-- V17 (ADR-028): what an execution step means, so its independence rule does not depend on its key. HANDOVER: the
-- delivering side, never the requester; RECEIPT: the receiving party confirms a completed handover, never the same human
-- who handed over; ACKNOWLEDGEMENT: the requester records completing their own work (not an approval); TASK: other steps.
alter table execution_task add column purpose text not null default 'TASK'
  check (purpose in ('HANDOVER', 'RECEIPT', 'ACKNOWLEDGEMENT', 'TASK'));
-- existing steps take the meaning of the built-in templates they were created from
update execution_task set purpose = case key when 'handover' then 'HANDOVER' when 'receipt' then 'RECEIPT'
                                            when 'relocated' then 'ACKNOWLEDGEMENT' else 'TASK' end;

alter table doc_updates drop constraint doc_updates_size;

alter table doc_updates
  add constraint doc_updates_size check (octet_length("update") <= 5242880);

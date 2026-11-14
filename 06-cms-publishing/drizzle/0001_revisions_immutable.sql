-- Custom SQL migration file, put your code below! --
CREATE FUNCTION "reject_revision_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'revisions are immutable' USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "revisions_reject_update"
BEFORE UPDATE ON "revisions"
FOR EACH ROW EXECUTE FUNCTION "reject_revision_update"();

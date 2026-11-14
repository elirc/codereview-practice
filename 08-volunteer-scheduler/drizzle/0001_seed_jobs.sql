-- Custom SQL migration file, put your code below! --
INSERT INTO `jobs` (`name`, `interval_seconds`, `next_run_at`, `consecutive_failures`) VALUES
	('materialize', 21600, 0, 0),
	('reminders', 300, 0, 0),
	('cleanup', 86400, 0, 0)
ON CONFLICT (`name`) DO NOTHING;

import { cleanupJob } from './cleanup';
import { materializeJob } from './materialize';
import { remindersJob } from './reminders';
import type { JobHandlers } from './runner';

export const jobHandlers: JobHandlers = {
	materialize: materializeJob,
	reminders: remindersJob,
	cleanup: cleanupJob
};

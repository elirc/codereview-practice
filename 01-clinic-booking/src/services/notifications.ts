import { EMAIL_RETRY, jobs, type AppointmentEmailQueue } from "@/server/jobs";
import { logger } from "@/server/logger";

/**
 * Enqueues a patient email after the change it describes has committed. A failure to enqueue
 * is logged rather than surfaced, since the appointment change itself already succeeded.
 */
export async function enqueueAppointmentEmail(
  queue: AppointmentEmailQueue,
  appointmentId: string,
): Promise<void> {
  try {
    await jobs.publish(queue, { appointmentId }, { singletonKey: appointmentId, ...EMAIL_RETRY });
  } catch (err) {
    logger.error({ err, queue, appointmentId }, "failed to enqueue appointment email");
  }
}

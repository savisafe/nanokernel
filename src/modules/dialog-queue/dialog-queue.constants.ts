export const DIALOG_INBOUND_QUEUE_NAME = "dialog-inbound";

export function isDialogQueueEnabled(): boolean {
  return process.env.DIALOG_QUEUE_ENABLED !== "false";
}

export function isDialogQueueWorkerEnabled(): boolean {
  return process.env.DIALOG_QUEUE_WORKER_ENABLED !== "false";
}

export const MSG = Object.freeze({
  // Main → Worker
  INIT: 'INIT',
  PROCESS_FILE: 'PROCESS_FILE',

  // Worker → Main
  WORKER_READY: 'WORKER_READY',
  PROGRESS: 'PROGRESS',
  LOG: 'LOG',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
})

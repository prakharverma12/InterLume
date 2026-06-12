import config from '../config.json'

export const DEBUG = config.debug === true

/**
 * Creates a debug logger bound to a postMessage-style log function.
 * Returns a `dbg(line)` function that is a no-op when DEBUG is false.
 */
export function makeDbg(logFn) {
  if (!DEBUG) return () => {}
  return (line) => {
    console.log(`[DBG] ${line}`)
    logFn(`[DBG] ${line}`)
  }
}

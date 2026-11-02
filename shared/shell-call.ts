/**
 * The one name a tool call and the process environment share: a call names its own shell in the execution's environment
 * under this key, the environment records what that call's process group left running under it, and the tool reads the
 * count back through `shellLeftovers`. Both sides import it here so a rename cannot silently disable the diagnostic.
 */
export const SHELL_CALL = 'ULTIMATE_SHELL_CALL'

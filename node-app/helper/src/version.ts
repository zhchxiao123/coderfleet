/** The helper's own version; CoderFleet replaces an installed helper that reports another one. */
export const VERSION = '0.2.0';
/**
 * The contract between the helper and whoever manages it (token format, /control routes).
 * A manager only works with a helper that reports the same number; there is no compatibility layer.
 */
export const PROTOCOL = 1;

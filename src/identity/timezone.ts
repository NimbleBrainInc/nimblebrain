import { log } from "../observability/log.ts";
import type { UserPreferences } from "./user.ts";

/** The timezone a person has when neither their profile nor the operator names one. */
export const FALLBACK_TIMEZONE = "UTC";

/** Whether `name` is an IANA timezone this runtime's `Intl` knows. */
export function isKnownTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * The operator's default timezone for people's profiles, from `NB_TIMEZONE`,
 * checked once where it enters: an unset value is UTC, and an unknown name is
 * UTC with a warning, so no reader has to guard for a name `Intl` refuses.
 */
export function resolveOperatorTimezone(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return FALLBACK_TIMEZONE;
  if (isKnownTimezone(value)) return value;
  log.warn("[identity] NB_TIMEZONE is not a known timezone; using UTC", { value });
  return FALLBACK_TIMEZONE;
}

/**
 * A person's effective timezone: their profile's `timezone` when it names a
 * known zone, else the operator's default (already resolved by
 * {@link resolveOperatorTimezone}). The operator's value is a default for
 * profiles, never a preference: it is applied when read and never written to
 * the profile, so a person's own choice always wins and an operator change
 * reaches everyone who has not chosen.
 */
export function effectiveTimezone(
  preferences: UserPreferences | undefined,
  operatorTimezone: string,
): string {
  const own = preferences?.timezone?.trim();
  return own && isKnownTimezone(own) ? own : operatorTimezone;
}

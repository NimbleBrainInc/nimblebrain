/**
 * The longest workspace name a form accepts: the server's
 * `MAX_WORKSPACE_NAME_CHARS` (`src/workspace/types.ts`), which refuses a longer
 * name. A field's `maxLength` counts UTF-16 units and the server counts
 * characters, so an emoji takes two of the field's 80: the field is only ever
 * stricter than the server, never looser.
 */
export const MAX_WORKSPACE_NAME_LENGTH = 80;

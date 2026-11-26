// ---------------------------------------------------------------------------
// The host's bridge constants, as one document.
//
// `schemas/host-bridge/v1/constants.json` at the repo root states the
// identifiers and limits an app's SDK has to agree with: the extensions this
// host declares, the bounds it drops or refuses a message over, the timeout and rate-limit errors it answers, and the theme
// values it sends. `@nimblebrain/synapse` keeps its own copy of each (a client
// cannot import a host) and tests that copy against the document, so a value
// changed on one side alone fails a test instead of failing silently in an app.
//
// Every value is read from the definition the bridge itself runs on, never
// restated, and `test/unit/bridge/host-constants.test.ts` fails when the
// committed file differs from what this module builds. Regenerate with
// `bun run gen:host-constants`.
//
// The shape is a contract: a reader checks `version` before anything else. A
// new field is additive. Renaming, removing or changing the meaning of a field
// bumps `HOST_CONSTANTS_VERSION`.
// ---------------------------------------------------------------------------

import {
  RATE_LIMITED,
  REQUEST_TIMEOUT,
  RETRY_AFTER_DATA_FIELD,
  SUSPENSION_DATA_FIELD,
} from "../mcp-bridge-client";
import { spacing } from "../theme/palette.ts";
import { HOST_STYLES_EXTENSION, NAVIGATE_METHOD, NIMBLEBRAIN_EXTENSIONS } from "./extensions";
import {
  DEFAULT_PICKER_MAX_SIZE,
  MAX_NOTICE_DESCRIPTION,
  MAX_NOTICE_TITLE,
  NOTICE_BURST,
  NOTICE_LEVELS,
  NOTICE_WINDOW_MS,
} from "./limits";
import { AppTrailEntry, UiLocationMessage } from "./schemas";
import { getModeExtensionTokens } from "./theme";

export const HOST_CONSTANTS_VERSION = 1;

export interface HostConstants {
  version: typeof HOST_CONSTANTS_VERSION;
  extensions: {
    /** App → host methods, each declared in `hostCapabilities.experimental` under its own name. */
    declared: string[];
    /** Host → app methods, which need no declaration. */
    hostToApp: string[];
    /** Host-context keys outside the spec. */
    hostContext: string[];
  };
  limits: {
    /** `ai.nimblebrain/location`: a message outside these is dropped unanswered. */
    location: {
      maxTrailEntries: number;
      minLabelLength: number;
      maxLabelLength: number;
      maxIdLength: number;
    };
    /** `ai.nimblebrain/notify`: a request outside these is answered with an error. */
    notify: {
      levels: string[];
      maxTitleLength: number;
      maxDescriptionLength: number;
      /** At most `burst` notices per app in any `windowMs`. */
      burst: number;
      windowMs: number;
    };
    files: {
      /** The picker's per-file cap, in bytes, when the instance configures none. */
      defaultMaxFileSize: number;
    };
  };
  errors: {
    /** The JSON-RPC code for a request that got no answer in time. */
    requestTimeout: number;
    /** The `error.data` field that error carries when the page was suspended. */
    suspensionDataField: string;
    /** The JSON-RPC code for a request the host refused under its rate limit. */
    rateLimited: number;
    /** The `error.data` field that error carries: the wait, in ms, before asking again. */
    retryAfterDataField: string;
  };
  theme: {
    /** The values of `--nb-gutter-wide` and `--nb-gutter-narrow`, and the frame width at or under which the narrow one applies. */
    gutter: { wide: string; narrow: string; narrowBreakpointPx: number };
    /** The variables sent on the `ai.nimblebrain/styles` host-context extension. */
    modeExtensionVariables: string[];
  };
}

/** A schema bound the document publishes; a schema that stops declaring it is a build failure, not a missing field. */
function bound(value: number | undefined, name: string): number {
  if (value === undefined) throw new Error(`${name} is not declared on the bridge schema`);
  return value;
}

export function buildHostConstants(): HostConstants {
  const trail = UiLocationMessage.properties.params.properties.trail;
  return {
    version: HOST_CONSTANTS_VERSION,
    extensions: {
      declared: [...NIMBLEBRAIN_EXTENSIONS],
      hostToApp: [NAVIGATE_METHOD],
      hostContext: [HOST_STYLES_EXTENSION],
    },
    limits: {
      location: {
        maxTrailEntries: bound(trail.maxItems, "trail maxItems"),
        minLabelLength: bound(AppTrailEntry.properties.label.minLength, "label minLength"),
        maxLabelLength: bound(AppTrailEntry.properties.label.maxLength, "label maxLength"),
        maxIdLength: bound(AppTrailEntry.properties.id.maxLength, "id maxLength"),
      },
      notify: {
        levels: [...NOTICE_LEVELS],
        maxTitleLength: MAX_NOTICE_TITLE,
        maxDescriptionLength: MAX_NOTICE_DESCRIPTION,
        burst: NOTICE_BURST,
        windowMs: NOTICE_WINDOW_MS,
      },
      files: { defaultMaxFileSize: DEFAULT_PICKER_MAX_SIZE },
    },
    errors: {
      requestTimeout: REQUEST_TIMEOUT,
      suspensionDataField: SUSPENSION_DATA_FIELD,
      rateLimited: RATE_LIMITED,
      retryAfterDataField: RETRY_AFTER_DATA_FIELD,
    },
    theme: {
      gutter: {
        wide: spacing.gutter,
        narrow: spacing.gutterNarrow,
        narrowBreakpointPx: spacing.narrowBreakpointPx,
      },
      // Which variables vary with the mode is the same in either mode. Sorted,
      // because the order the palette projects them in carries no meaning.
      modeExtensionVariables: Object.keys(getModeExtensionTokens("light")).sort(),
    },
  };
}

/** The committed file's exact bytes: no timestamp or revision, keys in the order built above. */
export function serializeHostConstants(constants: HostConstants = buildHostConstants()): string {
  return `${JSON.stringify(constants, null, 2)}\n`;
}

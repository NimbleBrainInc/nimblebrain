import { defaultRehypePlugins, type LinkSafetyConfig, type StreamdownProps } from "streamdown";
import { LinkSafetyModal } from "../components/LinkSafetyModal";

/**
 * Shared Streamdown config, passed at every `<Streamdown>` render site so the
 * treatment is consistent everywhere:
 *
 *   <Streamdown linkSafety={linkSafety} rehypePlugins={rehypePlugins} …>
 */

/**
 * Link safety. Streamdown intercepts external-link clicks in rendered markdown
 * and shows a confirmation modal. Left to its defaults that modal wears
 * Streamdown's own styling; pointing `renderModal` at the first-party
 * {@link LinkSafetyModal} makes it NimbleBrain's.
 */
export const linkSafety: LinkSafetyConfig = {
  enabled: true,
  renderModal: (props) => <LinkSafetyModal {...props} />,
};

const CLOBBER_PREFIX = "user-content-";

/**
 * Streamdown's default rehype pipeline with the sanitize schema's
 * `clobberPrefix` pinned to `user-content-`.
 *
 * The markdown rendered here is untrusted (model output, artifacts, skill
 * bodies), and raw HTML in it passes through the sanitizer. Streamdown's
 * default schema sets `clobberPrefix: ""`, which emits raw-HTML `id` / `name`
 * attributes verbatim. An unprefixed `<img name="cookie">` shadows
 * `document.cookie`, and any `id` becomes a `window` named property (DOM
 * clobbering). The prefix keeps those attributes out of the global namespace.
 */
export const rehypePlugins: NonNullable<StreamdownProps["rehypePlugins"]> = Object.entries(
  defaultRehypePlugins,
).map(([key, plugin]) => {
  if (key !== "sanitize" || !Array.isArray(plugin)) return plugin;
  const [sanitize, schema] = plugin;
  return [sanitize, { ...(schema as object), clobberPrefix: CLOBBER_PREFIX }];
});

import type { LinkSafetyConfig } from "streamdown";
import { LinkSafetyModal } from "../components/LinkSafetyModal";

/**
 * Shared Streamdown link-safety config.
 *
 * Streamdown intercepts external-link clicks in rendered markdown and shows a
 * confirmation modal. Left to its defaults that modal wears Streamdown's own
 * styling; pointing `renderModal` at the first-party {@link LinkSafetyModal}
 * makes it NimbleBrain's. Spread onto every `<Streamdown>` render site so the
 * treatment is consistent everywhere:
 *
 *   <Streamdown linkSafety={linkSafety} …>
 */
export const linkSafety: LinkSafetyConfig = {
  enabled: true,
  renderModal: (props) => <LinkSafetyModal {...props} />,
};

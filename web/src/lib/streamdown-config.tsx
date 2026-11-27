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
type RehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>;

const defaultsWithClobberPrefix: RehypePlugins = Object.entries(defaultRehypePlugins).map(
  ([key, plugin]) => {
    if (key !== "sanitize" || !Array.isArray(plugin)) return plugin;
    const [sanitize, schema] = plugin;
    return [sanitize, { ...(schema as object), clobberPrefix: CLOBBER_PREFIX }];
  },
);

/** The slice of a hast node this module reads and writes. */
interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

/**
 * Whether `src` resolves to the page's own origin. Relative URLs (a stored
 * file at `/v1/workspaces/<wsId>/files/<id>`) resolve against the page and pass; anything that
 * does not parse, or names another host, does not.
 */
function isOwnOrigin(src: unknown): boolean {
  const here = globalThis.location;
  if (typeof src !== "string" || !here?.origin || here.origin === "null") return false;
  try {
    return new URL(src, here.href).origin === here.origin;
  } catch {
    return false;
  }
}

/**
 * What a markdown image from another origin renders as: a link to it, through
 * the link-safety confirmation like any other link, so it loads only when the
 * reader chooses to open it. Inside a link (a linked image) a nested `<a>` is
 * invalid HTML, so it becomes the label alone.
 */
function imageAsLink(img: HastNode, insideLink: boolean): HastNode {
  const src = typeof img.properties?.src === "string" ? img.properties.src : "";
  const alt = typeof img.properties?.alt === "string" ? img.properties.alt.trim() : "";
  const label: HastNode = { type: "text", value: alt || src || "image" };
  if (insideLink || !src) return label;
  return {
    type: "element",
    tagName: "a",
    properties: { href: src, target: "_blank", rel: "noopener noreferrer" },
    children: [label],
  };
}

function keepImagesOnOwnOrigin(parent: HastNode, insideLink: boolean): void {
  if (!parent.children) return;
  parent.children = parent.children.flatMap((child): HastNode[] => {
    if (child.type !== "element") return [child];
    // `<source srcset>` (inside `<picture>`) fetches on render like `<img src>`.
    // Dropping it leaves the picture's own `<img>`, which is checked below.
    if (child.tagName === "source") return [];
    if (child.tagName === "img") {
      return [isOwnOrigin(child.properties?.src) ? child : imageAsLink(child, insideLink)];
    }
    keepImagesOnOwnOrigin(child, insideLink || child.tagName === "a");
    return [child];
  });
}

/**
 * Images in rendered markdown load only from the app's own origin; an image
 * from any other origin is shown as a link to it instead.
 *
 * A browser fetches an `<img>` as soon as it renders, so an image URL in model
 * output or an artifact would otherwise be requested with no action from the
 * reader, carrying whatever the URL holds. Runs after sanitize, so it sees
 * raw-HTML images too.
 */
export function rehypeOwnOriginImages() {
  return (tree: HastNode) => keepImagesOnOwnOrigin(tree, false);
}

/** Every render site's rehype pipeline: the defaults above, then {@link rehypeOwnOriginImages}. */
export const rehypePlugins: RehypePlugins = [...defaultsWithClobberPrefix, rehypeOwnOriginImages];

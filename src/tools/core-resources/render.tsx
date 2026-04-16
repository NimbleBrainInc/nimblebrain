import { renderToStaticMarkup } from "react-dom/server";
import { BASE_STYLES } from "./styles.ts";
import { SYNAPSE_RUNTIME } from "./synapse-runtime.ts";

interface ShellProps {
  styles: string;
  script: string;
  children?: React.ReactNode;
}

function Shell({ styles, script, children }: ShellProps) {
  return (
    // biome-ignore lint/a11y/useHtmlLang: server-rendered iframe shell, lang not applicable
    <html>
      <head>
        <meta charSet="utf-8" />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted server-side style injection */}
        <style dangerouslySetInnerHTML={{ __html: BASE_STYLES + styles }} />
      </head>
      <body>
        {children || <div id="app" />}
        <script // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted server-side script injection
          dangerouslySetInnerHTML={{
            __html: `${SYNAPSE_RUNTIME}\n${script}`,
          }}
        />
      </body>
    </html>
  );
}

export function renderResource(styles: string, script: string, children?: React.ReactNode): string {
  return (
    "<!DOCTYPE html>" +
    renderToStaticMarkup(
      <Shell styles={styles} script={script}>
        {children}
      </Shell>,
    )
  );
}

/**
 * Render an HTML fragment for injection into a parent page (e.g., settings shell).
 * Returns style + container div + script WITHOUT the full HTML/head/body wrapper
 * and WITHOUT the bridge runtime (parent page already has it).
 */
export function renderFragment(styles: string, script: string): string {
  return `<style>${styles}</style><div id="section-root"></div><script>(function(){${script}})()</script>`;
}

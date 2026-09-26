/**
 * Attribution for connector-authored UI rendered inside host settings: a faint
 * line naming the server the content came from.
 *
 * It is a footer, not a subtitle, so it recedes. In subtitle position it would
 * compete with the connector's own internal title for attention.
 */
export function ProvidedBy({ serverName }: { serverName: string }) {
  return (
    <p className="pt-2 text-right text-xs text-muted-foreground">
      Provided by <code className="text-2xs">{serverName}</code>
    </p>
  );
}

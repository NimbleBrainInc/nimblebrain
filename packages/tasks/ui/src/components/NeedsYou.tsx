import { StatusIcon } from "../icons.tsx";

/**
 * The two things that fix a run that asks for the person: change the task's
 * instructions, or ask the agent in chat. "Ask in chat" is drawn only where the
 * host takes a message from the screen.
 */
export function FixActions({ onEdit, onAsk }: { onEdit?: () => void; onAsk?: () => void }) {
  return (
    <>
      {onEdit && (
        <button type="button" className="btn btn-sm" onClick={onEdit}>
          Edit instructions
        </button>
      )}
      {onAsk && (
        <button type="button" className="btn btn-sm" onClick={onAsk}>
          Ask in chat
        </button>
      )}
    </>
  );
}

/** Why a run asks for the person, in one sentence, with what fixes it. */
export function NeedsYouCallout({
  sentence,
  tone,
  onEdit,
  onAsk,
}: {
  sentence: string;
  tone: "warning" | "danger";
  onEdit?: () => void;
  onAsk?: () => void;
}) {
  return (
    <div className={`callout tone-${tone}`} role="status">
      <StatusIcon tone={tone} />
      <span>{sentence}</span>
      <FixActions onEdit={onEdit} onAsk={onAsk} />
    </div>
  );
}

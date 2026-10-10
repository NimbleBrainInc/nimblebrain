/**
 * The one form a model id takes: `provider:model` (`anthropic:claude-sonnet-4-6`).
 *
 * The provider is part of the id, not something inferred from it. Two providers
 * can serve the same vendor id (an OpenAI-compatible gateway re-serving another
 * vendor's model), so an id without its provider names no model. Every place a
 * person or an operator writes a model (config, `set_model_config`,
 * `set_preferences`, a request's `model`, a task's `model`) refuses one without
 * a provider, and the refusal names the qualified form to write instead.
 *
 * A slot name (`fast`, `alias:fast`) is a reference, not a model id; the
 * callers that accept one resolve it before reaching here (`slots.ts`).
 */
import { findProviderForModelId } from "./catalog.ts";

/** True when `model` is `provider:model` with both halves present. */
export function isQualifiedModelId(model: string): boolean {
  const i = model.indexOf(":");
  return i > 0 && i < model.length - 1;
}

/**
 * The refusal for an id that is not `provider:model`, or null when it is.
 *
 * The suggestion comes from the catalog when the vendor id is in it, so the
 * operator can paste it back; otherwise it shows the shape with a placeholder,
 * because guessing a provider is exactly what this refuses to do.
 */
export function unqualifiedModelIdError(model: string, subject = "Model"): string | null {
  if (isQualifiedModelId(model)) return null;
  const provider = findProviderForModelId(model);
  const example = provider ? `"${provider}:${model}"` : `"<provider>:${model}"`;
  return `${subject} "${model}" has no provider. Write it as provider:model, e.g. ${example}.`;
}

/**
 * Thrown where a model id that is not `provider:model` reaches code that needs
 * one. The HTTP handler maps it to `400 model_not_qualified`.
 */
export class ModelNotQualifiedError extends Error {
  readonly code = "model_not_qualified";
  constructor(
    public readonly model: string,
    subject?: string,
  ) {
    super(unqualifiedModelIdError(model, subject) ?? `Model "${model}" is not provider:model.`);
    this.name = "ModelNotQualifiedError";
  }
}

/** Return `model` unchanged, or throw `ModelNotQualifiedError` naming the qualified form. */
export function requireQualifiedModelId(model: string, subject?: string): string {
  if (!isQualifiedModelId(model)) throw new ModelNotQualifiedError(model, subject);
  return model;
}

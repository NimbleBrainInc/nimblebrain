import { useId } from "react";
import {
  type CriterionDraft,
  type CriterionType,
  emptyDraft,
  idFromRule,
  lines,
  MAX_CRITERIA,
  validateDrafts,
} from "../lib/criteria.ts";

/**
 * The criteria list: each rule in plain language, its type, levels or
 * options, and what passes. Problems show under each criterion as you type.
 */
export function CriteriaEditor({
  drafts,
  onChange,
}: {
  drafts: CriterionDraft[];
  onChange: (drafts: CriterionDraft[]) => void;
}) {
  const base = useId();
  const { items, list } = validateDrafts(drafts);
  const set = (i: number, patch: Partial<CriterionDraft>) =>
    onChange(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  return (
    <div className="criteria-editor">
      {drafts.length === 0 && (
        <p className="hint">
          No criteria: a run is judged only by its output schema, if it has one. Add a rule a good
          result always meets.
        </p>
      )}
      <ol className="criteria-list">
        {drafts.map((d, i) => {
          const id = `${base}-${i}`;
          const errs = items[i] ?? [];
          const levels = lines(d.levels);
          const options = lines(d.options);
          return (
            <li key={id} className="criterion-card" aria-label={`Criterion ${i + 1}`}>
              <div className="field">
                <label className="field-label" htmlFor={`${id}-rule`}>
                  Rule
                </label>
                <textarea
                  id={`${id}-rule`}
                  className="inline-edit-textarea"
                  rows={2}
                  value={d.rule}
                  placeholder="Every claim cites a source fetched during this run."
                  onChange={(e) => set(i, { rule: e.target.value })}
                  onBlur={() => {
                    if (!d.id && d.rule.trim()) {
                      set(i, {
                        id: idFromRule(
                          d.rule,
                          drafts.map((x) => x.id),
                        ),
                      });
                    }
                  }}
                />
              </div>
              <div className="field-row">
                <div className="field">
                  <label className="field-label" htmlFor={`${id}-type`}>
                    Answer
                  </label>
                  <select
                    id={`${id}-type`}
                    className="inline-edit-input"
                    value={d.type}
                    onChange={(e) => set(i, { type: e.target.value as CriterionType })}
                  >
                    <option value="boolean">Yes or no</option>
                    <option value="score">A level on a scale</option>
                    <option value="choice">One of some options</option>
                  </select>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor={`${id}-id`}>
                    Id
                  </label>
                  <input
                    id={`${id}-id`}
                    className="inline-edit-input mono"
                    value={d.id}
                    onChange={(e) => set(i, { id: e.target.value })}
                  />
                </div>
              </div>
              {d.type === "boolean" && (
                <div className="field">
                  <label className="field-label" htmlFor={`${id}-pass`}>
                    Passes when the answer is
                  </label>
                  <select
                    id={`${id}-pass`}
                    className="inline-edit-input"
                    value={d.passTrue ? "yes" : "no"}
                    onChange={(e) => set(i, { passTrue: e.target.value === "yes" })}
                  >
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </div>
              )}
              {d.type === "score" && (
                <div className="field-row">
                  <div className="field">
                    <label className="field-label" htmlFor={`${id}-levels`}>
                      Levels, lowest first (one per line)
                    </label>
                    <textarea
                      id={`${id}-levels`}
                      className="inline-edit-textarea"
                      rows={3}
                      value={d.levels}
                      placeholder={"unsupported\npartly supported\nsupported"}
                      onChange={(e) => set(i, { levels: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor={`${id}-plevel`}>
                      Lowest passing level
                    </label>
                    <select
                      id={`${id}-plevel`}
                      className="inline-edit-input"
                      value={String(d.passLevel)}
                      onChange={(e) =>
                        set(i, { passLevel: e.target.value === "" ? "" : Number(e.target.value) })
                      }
                    >
                      <option value="">Upper half (default)</option>
                      {levels.map((l, k) => (
                        <option key={l} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              {d.type === "choice" && (
                <div className="field-row">
                  <div className="field">
                    <label className="field-label" htmlFor={`${id}-options`}>
                      Options (one per line)
                    </label>
                    <textarea
                      id={`${id}-options`}
                      className="inline-edit-textarea"
                      rows={3}
                      value={d.options}
                      onChange={(e) => set(i, { options: e.target.value })}
                    />
                  </div>
                  <fieldset className="field">
                    <legend className="field-label">Options that pass</legend>
                    {options.length === 0 && <span className="hint">List the options first.</span>}
                    {options.map((o) => (
                      <label key={o} className="check">
                        <input
                          type="checkbox"
                          checked={d.passOptions.includes(o)}
                          onChange={(e) =>
                            set(i, {
                              passOptions: e.target.checked
                                ? [...d.passOptions, o]
                                : d.passOptions.filter((x) => x !== o),
                            })
                          }
                        />
                        {o}
                      </label>
                    ))}
                  </fieldset>
                </div>
              )}
              {errs.map((e) => (
                <div key={e} className="field-error">
                  {e}
                </div>
              ))}
              <button
                type="button"
                className="link-btn danger"
                onClick={() => onChange(drafts.filter((_, j) => j !== i))}
              >
                Remove criterion {i + 1}
              </button>
            </li>
          );
        })}
      </ol>
      {list.map((e) => (
        <div key={e} className="field-error">
          {e}
        </div>
      ))}
      <button
        type="button"
        className="btn"
        disabled={drafts.length >= MAX_CRITERIA}
        onClick={() => onChange([...drafts, emptyDraft()])}
      >
        Add a criterion
      </button>
    </div>
  );
}

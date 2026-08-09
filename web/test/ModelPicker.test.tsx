import { fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  ModelPicker,
  type PickerModel,
  shortModelName,
  toPickerModels,
} from "../src/components/ModelPicker.tsx";

// happy-dom's Window stub doesn't expose SyntaxError/TypeError; querySelector's
// selector parser constructs one and trips on the gap. Same patch the
// RecentConversationsPopover suite uses.
{
  const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

/**
 * The control has two states and the difference between them is the feature.
 *
 * Before the first message it picks the model the conversation will be bound
 * to. After, the binding cannot move — so the same control states it and its
 * menu offers the only thing that can change the model, which is a new
 * conversation. A control that simply stopped responding would read as broken.
 */

/** Two providers, given in the order `toPickerModels` would emit them. */
const MULTI: PickerModel[] = [
  { id: "anthropic:claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
  { id: "openai:gpt-5", name: "GPT-5", provider: "openai" },
  { id: "xai:grok-4-5", name: "Grok 4.5", provider: "xai" },
];

const MODELS: PickerModel[] = [
  { id: "anthropic:claude-sonnet-5", name: "Claude Sonnet 5", provider: "anthropic" },
  { id: "anthropic:claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "openai:gpt-5", name: "GPT-5", provider: "openai" },
];

/**
 * Queries are scoped to this render's own container rather than `screen`: the
 * whole web suite shares one happy-dom document, and a sibling file that
 * leaves a mounted popover behind would otherwise answer these queries.
 */
let mounted: { unmount: () => void } | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function mount(element: React.ReactElement) {
  const result = render(element);
  mounted = result;
  return within(result.container);
}

describe("shortModelName", () => {
  it("drops a vendor word the product already implies, and only that one", () => {
    expect(shortModelName("Claude Sonnet 5")).toBe("Sonnet 5");
    // Every other vendor's name carries information and is left alone.
    expect(shortModelName("GPT-5")).toBe("GPT-5");
    expect(shortModelName("Gemini 3 Flash")).toBe("Gemini 3 Flash");
  });
});

describe("toPickerModels", () => {
  it("qualifies each id with its provider", () => {
    const models = toPickerModels({
      anthropic: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
    });
    // The id is what reaches the wire and becomes the pin, so it must carry
    // the provider — a bare id would resolve by catalog guess.
    expect(models[0]?.id).toBe("anthropic:claude-sonnet-5");
  });

  it("is empty when the deployment offers nothing", () => {
    expect(toPickerModels(undefined)).toEqual([]);
  });

  it("shows a model once when the catalog carries both its ids", () => {
    const models = toPickerModels({
      anthropic: [
        { id: "claude-opus-4-5", name: "Claude Opus 4.5 (latest)" },
        { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5" },
      ],
    });
    // One model, one row — and the row is the undated id, which is the form
    // the operator config writes and the only form every model has.
    expect(models).toEqual([
      { id: "anthropic:claude-opus-4-5", name: "Claude Opus 4.5", provider: "anthropic" },
    ]);
  });

  it("drops the (latest) suffix with the duplicate that gave it meaning", () => {
    const [opus] = toPickerModels({
      anthropic: [
        { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5" },
        { id: "claude-opus-4-5", name: "Claude Opus 4.5 (latest)" },
      ],
    });
    // "(latest)" means newest 4.5 snapshot, but reads as newest Opus — false
    // as soon as Opus 5 ships, and distinguishing nothing once the pair is one.
    expect(opus?.name).toBe("Claude Opus 4.5");
  });

  it("collapses the other vendor's date format too", () => {
    const ids = toPickerModels({
      openai: [
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "gpt-4o-2024-08-06", name: "GPT-4o" },
        { id: "gpt-4o-2024-11-20", name: "GPT-4o" },
      ],
    }).map((m) => m.id);
    // Two snapshots, not one — a rule that carried a snapshot's name across
    // would have to pick between them; stripping the suffix from the survivor
    // does not.
    expect(ids).toEqual(["openai:gpt-4o"]);
  });

  it("keeps a snapshot that is the only way to name its model", () => {
    const ids = toPickerModels({
      anthropic: [{ id: "claude-opus-4-9-20260401", name: "Claude Opus 4.9" }],
    }).map((m) => m.id);
    // No undated sibling on offer: dropping this would remove the model.
    expect(ids).toEqual(["anthropic:claude-opus-4-9-20260401"]);
  });

  it("orders each provider's models into one contiguous run", () => {
    // Real names from the live catalog, chosen because sorting them by name
    // alone interleaves the vendors: Gemini, GPT-5, Nano Banana puts an OpenAI
    // model between two Google ones. Provider first keeps a run whole.
    const models = toPickerModels({
      google: [
        { id: "gemini-3-flash", name: "Gemini 3 Flash" },
        { id: "nano-banana-2-lite", name: "Nano Banana 2 Lite" },
      ],
      openai: [{ id: "gpt-5", name: "GPT-5" }],
    });
    expect(models.map((m) => m.provider)).toEqual(["google", "google", "openai"]);
    expect(models.map((m) => m.name)).toEqual([
      "Gemini 3 Flash",
      "Nano Banana 2 Lite",
      "GPT-5",
    ]);
  });

  it("keeps a moving pointer that is a model in its own right", () => {
    const models = toPickerModels({
      // `gpt-5.3-chat` is deliberately present: it is what a rule that
      // collapsed on a `-latest` suffix would fold this into. The two are
      // different models — one is a pointer that moves, one does not — so the
      // rule has to key on the dated-snapshot id shape, not on the suffix.
      openai: [
        { id: "gpt-5.3-chat-latest", name: "GPT-5.3 Chat (latest)" },
        { id: "gpt-5.3-chat", name: "GPT-5.3 Chat" },
      ],
    });
    expect(models.map((m) => m.id).sort()).toEqual([
      "openai:gpt-5.3-chat",
      "openai:gpt-5.3-chat-latest",
    ]);
    // It absorbed nothing, so it keeps its suffix — that is the only thing
    // telling the two of them apart.
    expect(models.find((m) => m.id === "openai:gpt-5.3-chat-latest")?.name).toBe(
      "GPT-5.3 Chat (latest)",
    );
  });
});

/** Render the unbound picker and open its menu. */
function openPicker() {
  const view = mount(
    <ModelPicker models={MODELS} selected="anthropic:claude-sonnet-5" onSelect={() => {}} />,
  );
  fireEvent.click(view.getByRole("button", { name: /Sonnet 5/ }));
  return view;
}

describe("before the first message", () => {
  it("names the model a message sent now would use", () => {
    const view = mount(
      <ModelPicker models={MODELS} selected="anthropic:claude-sonnet-5" onSelect={() => {}} />,
    );
    expect(view.getByRole("button", { name: /Sonnet 5/ })).toBeDefined();
  });

  it("reports the chosen model by its qualified id", () => {
    const onSelect = mock(() => {});
    const view = mount(
      <ModelPicker models={MODELS} selected="anthropic:claude-sonnet-5" onSelect={onSelect} />,
    );
    fireEvent.click(view.getByRole("button", { name: /Sonnet 5/ }));
    fireEvent.click(view.getByRole("option", { name: /GPT-5/ }));
    expect(onSelect).toHaveBeenCalledWith("openai:gpt-5");
  });

  it("filters as you type", () => {
    const view = openPicker();
    fireEvent.change(view.getByLabelText("Search models"), { target: { value: "haiku" } });
    expect(view.queryByRole("option", { name: /Haiku 4\.5/ })).not.toBeNull();
    expect(view.queryByRole("option", { name: /GPT-5/ })).toBeNull();
  });

  it("moves the highlight with the arrow keys and commits it with Enter", () => {
    const onSelect = mock(() => {});
    const view = mount(
      <ModelPicker models={MODELS} selected="anthropic:claude-sonnet-5" onSelect={onSelect} />,
    );
    fireEvent.click(view.getByRole("button", { name: /Sonnet 5/ }));
    const search = view.getByLabelText("Search models");

    // The list renders in the order given — ordering is toPickerModels' job —
    // so the highlight starts on Sonnet 5 and steps to Haiku 4.5.
    fireEvent.keyDown(search, { key: "ArrowDown" });
    // The caret stays in the field, so the highlight has to be announced
    // rather than focused.
    expect(search.getAttribute("aria-activedescendant")).toBe(
      view.getByRole("option", { name: /Haiku 4\.5/ }).id,
    );

    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("anthropic:claude-haiku-4-5");
  });

  it("wraps the highlight past the ends of the list", () => {
    const view = openPicker();
    // Up from the first entry lands on the last, not on nothing.
    fireEvent.keyDown(view.getByLabelText("Search models"), { key: "ArrowUp" });
    expect(view.getByLabelText("Search models").getAttribute("aria-activedescendant")).toBe(
      view.getByRole("option", { name: /GPT-5/ }).id,
    );
  });

  it("moves the highlight when the pointer moves, not when a row slides under it", () => {
    const view = openPicker();
    const search = view.getByLabelText("Search models");
    const gpt = view.getByRole("option", { name: /GPT-5/ });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    const afterKey = search.getAttribute("aria-activedescendant");

    // Filtering slides rows under a cursor that never moved; the resulting
    // `mouseenter` must not take the highlight off the keyboard.
    fireEvent.mouseEnter(gpt);
    expect(search.getAttribute("aria-activedescendant")).toBe(afterKey);

    // Actual movement does.
    fireEvent.mouseMove(gpt);
    expect(search.getAttribute("aria-activedescendant")).toBe(gpt.id);
  });

  it("says so when nothing matches, rather than showing an empty box", () => {
    const view = openPicker();
    fireEvent.change(view.getByLabelText("Search models"), { target: { value: "zzz" } });
    expect(view.getByText(/No model matches/)).toBeDefined();
  });
});

describe("with more than one provider", () => {
  function openMulti() {
    const view = mount(
      <ModelPicker models={MULTI} selected="anthropic:claude-sonnet-5" onSelect={() => {}} />,
    );
    fireEvent.click(view.getByRole("button", { name: /Sonnet 5/ }));
    return view;
  }

  it("heads each provider's run with its name", () => {
    const view = openMulti();
    // Nothing on a row says who serves it — "Grok 4.5" and "GPT-5" are family
    // names, not vendors — so the header is the only place the vendor appears.
    expect(view.getByRole("group", { name: "Anthropic" })).toBeDefined();
    expect(view.getByRole("group", { name: "OpenAI" })).toBeDefined();
    expect(view.getByRole("group", { name: "xAI" })).toBeDefined();
  });

  it("keeps every option reachable from one keyboard walk", () => {
    const view = openMulti();
    const search = view.getByLabelText("Search models");
    // Grouping is a drawing decision; the highlight still indexes one list, so
    // three ArrowDowns from the first row wrap back to it.
    const ids = view.getAllByRole("option").map((o) => o.id);
    for (const expected of [ids[1], ids[2], ids[0]]) {
      fireEvent.keyDown(search, { key: "ArrowDown" });
      expect(search.getAttribute("aria-activedescendant")).toBe(expected);
    }
  });

  it("drops a group the filter emptied", () => {
    const view = openMulti();
    fireEvent.change(view.getByLabelText("Search models"), { target: { value: "grok" } });
    expect(view.queryByRole("group", { name: "xAI" })).not.toBeNull();
    expect(view.queryByRole("group", { name: "Anthropic" })).toBeNull();
  });

  it("heads nothing when one provider is all there is", () => {
    // The common deployment. A single header labelling the whole list names
    // nothing the list does not already imply.
    const view = mount(
      <ModelPicker
        models={MULTI.filter((m) => m.provider === "anthropic")}
        selected="anthropic:claude-sonnet-5"
        onSelect={() => {}}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: /Sonnet 5/ }));
    expect(view.queryAllByRole("group")).toHaveLength(0);
    expect(view.queryAllByRole("option")).toHaveLength(1);
  });
});

describe("once the conversation is bound", () => {
  it("states the binding rather than the pre-send choice", () => {
    const view = mount(
      <ModelPicker
        models={MODELS}
        selected="openai:gpt-5"
        bound="anthropic:claude-haiku-4-5"
        onSelect={() => {}}
      />,
    );
    // The binding wins: a leftover choice must not claim to be in force.
    expect(view.getByRole("button", { name: /Haiku 4\.5/ })).toBeDefined();
  });

  it("offers a new conversation instead of changing this one", () => {
    const onSelect = mock(() => {});
    const onNewConversation = mock(() => {});
    const view = mount(
      <ModelPicker
        models={MODELS}
        selected={undefined}
        bound="anthropic:claude-haiku-4-5"
        onSelect={onSelect}
        onNewConversation={onNewConversation}
      />,
    );
    fireEvent.click(view.getByRole("button", { name: /Haiku 4\.5/ }));
    expect(view.getByText(/This conversation uses/)).toBeDefined();

    fireEvent.click(view.getByRole("option", { name: /GPT-5/ }));
    expect(onNewConversation).toHaveBeenCalledWith("openai:gpt-5");
    // The bound conversation is never retargeted.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("names a pin that points at a snapshot the list collapsed", () => {
    // Operator config can set a dated snapshot, and this control produced them
    // itself before the list started collapsing them — so a real pin can name
    // an id no row carries. Its undated row is the same model.
    const view = mount(
      <ModelPicker
        models={MODELS}
        selected={undefined}
        bound="anthropic:claude-haiku-4-5-20251001"
        onSelect={() => {}}
      />,
    );
    expect(view.getByRole("button", { name: /Haiku 4\.5/ })).toBeDefined();
  });

  it("names a model the deployment no longer offers, rather than mislabelling it", () => {
    // A narrowed policy or a retired model leaves a pin with no catalog entry.
    const view = mount(
      <ModelPicker
        models={MODELS}
        selected={undefined}
        bound="anthropic:claude-opus-4"
        onSelect={() => {}}
      />,
    );
    expect(view.getByRole("button", { name: /anthropic:claude-opus-4/ })).toBeDefined();
  });
});

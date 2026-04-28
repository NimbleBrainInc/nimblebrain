import { describe, expect, it } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import { ReasoningBlock } from "../src/components/ReasoningBlock.tsx";

/**
 * Helpers — happy-dom's CSS selector parser has internal bugs that make
 * even `"button"` throw, so navigate the DOM via direct property access
 * rather than querySelector calls.
 */

/**
 * Expanded ⇔ the chevron has the `rotate-90` class. The body div is also
 * a signal but it's gated on `text` being non-empty (so streaming with no
 * text yet renders just the header even when conceptually expanded).
 * The chevron class flips on expand regardless of body presence, which
 * is what we want to assert.
 */
function isExpanded(container: HTMLElement): boolean {
  const button = getButton(container);
  const chevron = button.firstElementChild;
  return chevron?.classList.contains("rotate-90") ?? false;
}

function getButton(container: HTMLElement): HTMLButtonElement {
  const wrapper = container.firstElementChild;
  if (!wrapper) throw new Error("ReasoningBlock did not render");
  const button = wrapper.firstElementChild;
  if (!(button instanceof HTMLButtonElement)) throw new Error("First child is not a button");
  return button;
}

function headerText(container: HTMLElement): string {
  const button = getButton(container);
  // The header is icon, icon, span — the visible label is the last child.
  const lastChild = button.lastElementChild;
  return lastChild?.textContent ?? "";
}

describe("ReasoningBlock", () => {
	describe("initial expansion", () => {
		it("mounts collapsed when streaming=false (history rehydrate)", () => {
			const { container } = render(
				<ReasoningBlock text="Some prior reasoning." streaming={false} />,
			);
			expect(isExpanded(container)).toBe(false);
		});

		it("mounts expanded when streaming=true", () => {
			const { container } = render(<ReasoningBlock text="" streaming={true} />);
			expect(isExpanded(container)).toBe(true);
		});

		it("renders nothing when there's no text and not streaming", () => {
			const { container } = render(<ReasoningBlock text="" streaming={false} />);
			expect(container.innerHTML).toBe("");
		});
	});

	describe("auto-collapse on stream end", () => {
		it("auto-collapses when streaming transitions true → false", () => {
			const { container, rerender } = render(
				<ReasoningBlock text="thinking..." streaming={true} />,
			);
			expect(isExpanded(container)).toBe(true);

			rerender(<ReasoningBlock text="thinking..." streaming={false} />);
			expect(isExpanded(container)).toBe(false);
		});
	});

	describe("user override", () => {
		it("manual click during streaming sticks: subsequent stream-end does not force collapse", () => {
			const { container, rerender } = render(
				<ReasoningBlock text="thinking..." streaming={true} />,
			);
			// Auto-expanded while streaming
			expect(isExpanded(container)).toBe(true);

			// User clicks to collapse mid-stream
			fireEvent.click(getButton(container));
			expect(isExpanded(container)).toBe(false);

			// Streaming ends — must NOT force re-collapse, but more importantly
			// must not force re-expand either. The user said collapsed; it stays.
			rerender(<ReasoningBlock text="thinking..." streaming={false} />);
			expect(isExpanded(container)).toBe(false);
		});

		it("manual click during streaming to expand (after manual collapse) sticks", () => {
			const { container, rerender } = render(
				<ReasoningBlock text="thinking..." streaming={true} />,
			);

			// Click off, then click on — the override is sticky regardless of
			// the streaming flag's later transitions.
			fireEvent.click(getButton(container)); // -> collapsed
			fireEvent.click(getButton(container)); // -> expanded
			expect(isExpanded(container)).toBe(true);

			rerender(<ReasoningBlock text="thinking..." streaming={false} />);
			// Auto-collapse should NOT fire because user overrode.
			expect(isExpanded(container)).toBe(true);
		});
	});

	describe("header label", () => {
		it("shows 'Thinking…' when streaming with no text yet", () => {
			const { container } = render(<ReasoningBlock text="" streaming={true} />);
			expect(headerText(container)).toBe("Thinking…");
		});

		it("shows 'Thinking… N tokens' when streaming with short text", () => {
			// 80 chars → 20 tokens (under the 2,500-token Nk threshold)
			const text = "x".repeat(80);
			const { container } = render(<ReasoningBlock text={text} streaming={true} />);
			expect(headerText(container)).toBe("Thinking… 20 tokens");
		});

		it("shows 'Thinking… N.Nk tokens' when streaming past the Nk threshold", () => {
			// 12,000 chars → ~3000 tokens → "3.0k tokens"
			const text = "x".repeat(12_000);
			const { container } = render(<ReasoningBlock text={text} streaming={true} />);
			expect(headerText(container)).toBe("Thinking… 3.0k tokens");
		});

		it("shows 'Thoughts · N tokens' when not streaming with short text", () => {
			const text = "x".repeat(40); // 10 tokens
			const { container } = render(<ReasoningBlock text={text} streaming={false} />);
			expect(headerText(container)).toBe("Thoughts · 10 tokens");
		});

		it("shows 'Thoughts · N.Nk tokens' when not streaming past the Nk threshold", () => {
			const text = "x".repeat(20_000); // 5000 tokens → "5.0k tokens"
			const { container } = render(<ReasoningBlock text={text} streaming={false} />);
			expect(headerText(container)).toBe("Thoughts · 5.0k tokens");
		});
	});
});

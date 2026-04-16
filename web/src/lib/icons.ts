import { CircleDot, icons, type LucideIcon } from "lucide-react";

export const DEFAULT_ICON: LucideIcon = CircleDot;

/** Convert kebab-case icon name to PascalCase (e.g., "message-square" → "MessageSquare"). */
function kebabToPascal(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Resolve an icon name string to a Lucide component. Accepts kebab-case or PascalCase. */
export function resolveIcon(name?: string): LucideIcon {
  if (!name) return DEFAULT_ICON;

  // Try exact match first (PascalCase)
  if (name in icons) return icons[name as keyof typeof icons];

  // Try kebab-case → PascalCase
  const pascal = kebabToPascal(name);
  if (pascal in icons) return icons[pascal as keyof typeof icons];

  return DEFAULT_ICON;
}

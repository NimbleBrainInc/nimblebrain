import { useEffect, useState } from "react";

// Mobile breakpoint: viewports narrower than 768px get the full-width / drawer
// treatment instead of the desktop sidebar. Kept in one place so the chat
// chrome and the artifact panel agree on the boundary (both slide to 100%).
const MOBILE_QUERY = "(max-width: 767px)";

/** True when the viewport is below the mobile breakpoint; reacts to resize. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 768,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isMobile;
}

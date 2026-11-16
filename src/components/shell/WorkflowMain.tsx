"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { cx } from "@/lib/utils/format";

/** The workflow page area. Sync is a full-width workspace; the other steps keep the reading width. */
export function WorkflowMain({ children }: { children: ReactNode }) {
  const wide = usePathname().endsWith("/sync");
  return <main className={cx("mx-auto w-full min-w-0 flex-1", wide ? "max-w-none px-3 pb-3 pt-3 md:px-4" : "max-w-[1440px] px-5 pb-16 pt-7 md:px-8")}>{children}</main>;
}

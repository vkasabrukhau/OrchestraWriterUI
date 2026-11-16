"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, Settings, User } from "lucide-react";
import { useSession } from "@/lib/auth/session";
import { Avatar } from "@/components/ui/Avatar";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { cx } from "@/lib/utils/format";

export function UserMenu({ onStage, size = "md" }: { onStage?: boolean; size?: "sm" | "md" }) {
  const user = useSession((s) => s.user);
  const status = useSession((s) => s.status);
  const signOut = useSession((s) => s.signOut);
  const router = useRouter();

  if (status === "loading") {
    // same footprint as the avatar so the header does not shift when the session arrives
    return <span className={cx("shimmer shrink-0 rounded-full", size === "sm" ? "h-7 w-7" : "h-9 w-9")} aria-hidden />;
  }

  if (!user) {
    return (
      <Link href="/sign-in" className={cx("text-sm", onStage ? "text-stage-text-2 hover:text-stage-text" : "text-ink-2 hover:text-ink")}>
        Sign in
      </Link>
    );
  }

  return (
    <Menu
      align="end"
      className="w-64"
      trigger={
        <button type="button" className="focus-round shrink-0 rounded-full" aria-label="Account menu">
          <Avatar initials={user.initials} size={size === "sm" ? "sm" : "md"} />
        </button>
      }
    >
      <MenuLabel>
        <p className="text-sm font-medium text-ink">{user.name}</p>
        <p className="truncate text-xs text-ink-3">{user.email}</p>
      </MenuLabel>
      <MenuSeparator />
      <MenuItem href="/profile" icon={<User size={15} />}>
        Profile
      </MenuItem>
      <MenuItem href="/settings" icon={<Settings size={15} />}>
        Settings
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        icon={<LogOut size={15} />}
        onSelect={async () => {
          // the cookie must be gone before /sign-in, or the proxy bounces back to /library
          await signOut();
          router.push("/sign-in");
        }}
      >
        Sign out
      </MenuItem>
    </Menu>
  );
}

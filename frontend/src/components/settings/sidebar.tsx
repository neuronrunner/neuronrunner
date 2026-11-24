"use client";

import { useRouter, usePathname } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export default function SettingsSidebar() {
  const router = useRouter();
  const pathname = usePathname();

  const isActive = (path: string) => pathname.startsWith(path);

  return (
    <div className="min-w-full md:min-w-[260px]">
      <div className="hidden md:flex flex-col gap-4">
        {/* Placeholder if ever mounted */}
      </div>
    </div>
  );
}

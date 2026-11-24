import { LuPlug } from "react-icons/lu";
import { cn } from "@/lib/utils";
import type { Connector } from "@/lib/connectors";

export function ConnectorIcon({ connector, className }: { connector?: Connector; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", connector ? "border border-black/5 bg-white shadow-sm" : "bg-primary/10 text-primary", className)}>
    {connector ? <img src={connector.logo} alt="" width={26} height={26} loading="lazy" decoding="async" className="h-[60%] w-[60%] object-contain" /> : <LuPlug className="h-[21px] w-[21px]" />}
  </span>;
}

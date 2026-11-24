export interface UsageTotals {
  requests: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  charged_cost: string | number | null;
}

export interface UsageUser extends UsageTotals {
  user_uuid: string | null;
  username: string | null;
  display_name: string;
  compute_cost: string | number;
}

export interface WorkspaceAllowance {
  plan_slug: string;
  plan_name: string;
  is_free_plan: boolean;
  is_per_seat: boolean;
  seat_count: number;
  monthly_limit: string;
  monthly_used: string;
  monthly_remaining: string;
}

export interface WorkspaceVMQuota {
  included_vcpu_hours: number;
  included_vcpu_seconds: number;
  used_vcpu_seconds: number;
  used_vcpu_hours: number;
  remaining_vcpu_seconds: number;
  remaining_vcpu_hours: number;
  verified_for_free_vm: boolean;
  max_vm_tier: string;
  max_snapshots: number;
  max_vm_duration_minutes: number;
}

export interface WorkspaceUsageModel extends UsageTotals {
  model__name: string | null;
  model__display_name?: string | null;
  provider_name?: string;
  is_byos?: boolean;
  is_byok?: boolean;
}

export interface WorkspaceUsage {
  totals: UsageTotals;
  models: WorkspaceUsageModel[];
  users: UsageUser[];
  allowance?: WorkspaceAllowance;
  vm_quota?: WorkspaceVMQuota;
}

export interface WorkspaceRequestLog {
  uuid: string;
  created_at: string;
  user_uuid: string | null;
  username: string | null;
  display_name: string;
  model: string | null;
  provider: string;
  status: "pending" | "processing" | "completed" | "canceled" | "failed";
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number;
  charged_cost: string | number;
  cost: string | number | null;
  uses_byok: boolean;
  duration_seconds: number | null;
}

export interface WorkspaceLogs {
  logs: WorkspaceRequestLog[];
  users: Pick<UsageUser, "user_uuid" | "username" | "display_name">[];
  total: number;
  limit: number;
  offset: number;
}

export const usageCurrency = (value: string | number | null | undefined) =>
  `$${Number(value || 0).toFixed(6)}`;
export const usageNumber = (value: number | null | undefined) =>
  (value || 0).toLocaleString();

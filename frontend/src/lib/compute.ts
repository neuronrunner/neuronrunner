/**
 * Sandbox compute helpers.
 *
 * The backend stores `sandbox_cpu` in physical cores (Modal's unit).
 * Each physical core is exposed as 2 vCPU in the UI. CPU is always shared;
 * the reservation percentage is intentionally not shown to users.
 */
export const VCPU_PER_CORE = 2;

export const coresToVcpu = (cores?: number | null, fallbackCores = 0.5): number =>
  Math.round((cores || fallbackCores) * VCPU_PER_CORE * 100) / 100;

export const vcpuToCores = (vcpu: number): number => vcpu / VCPU_PER_CORE;

export const formatVcpu = (cores?: number | null, fallbackCores = 0.5): string =>
  `${coresToVcpu(cores, fallbackCores)} vCPU`;

/** Selectable CPU sizes in vCPU (stored as vcpu / 2 physical cores). */
export const VCPU_OPTIONS = [2, 4, 8];

export type VMTierId = "tier_1" | "tier_2" | "tier_3";

export interface ComputeTierPreset {
  id: VMTierId;
  label: string;
  cpu: number;
  memory_mb: number;
  memory_gb: number;
  disk_gb: number;
  hourly_rate: string;
  overage_hourly_rate: string;
  per_minute_rate: string;
  overage_per_minute_rate: string;
}

/**
 * Coupled, fixed compute preset tiers (dedicated Fly.io performance-cpu).
 * Independent CPU and RAM configuration is disallowed.
 */
export const COMPUTE_TIERS: readonly ComputeTierPreset[] = [
  {
    id: "tier_1",
    label: "Small",
    cpu: 2,
    memory_mb: 8192,
    memory_gb: 8,
    disk_gb: 32,
    hourly_rate: "0.24",
    overage_hourly_rate: "0.36",
    per_minute_rate: "0.004",
    overage_per_minute_rate: "0.006",
  },
  {
    id: "tier_2",
    label: "Large",
    cpu: 4,
    memory_mb: 16384,
    memory_gb: 16,
    disk_gb: 64,
    hourly_rate: "0.48",
    overage_hourly_rate: "0.72",
    per_minute_rate: "0.008",
    overage_per_minute_rate: "0.012",
  },
  {
    id: "tier_3",
    label: "Ultra",
    cpu: 8,
    memory_mb: 32768,
    memory_gb: 32,
    disk_gb: 128,
    hourly_rate: "0.96",
    overage_hourly_rate: "1.44",
    per_minute_rate: "0.016",
    overage_per_minute_rate: "0.024",
  },
] as const;

export const VM_DURATION_MIN_MINUTES = 2;
export const VM_DURATION_MAX_MINUTES = 60;
export const VM_DURATION_DEFAULT_MINUTES = 5;
export const VM_DURATION_PRESETS = [5, 15, 30, 60] as const;

export const isValidTierId = (value: unknown): value is VMTierId =>
  typeof value === "string" && COMPUTE_TIERS.some((t) => t.id === value);

export const getComputeTier = (tierId: string): ComputeTierPreset =>
  COMPUTE_TIERS.find((t) => t.id === tierId) || COMPUTE_TIERS[0];

export const matchTierByResources = (vcpu: number, memoryMb: number): ComputeTierPreset =>
  COMPUTE_TIERS.find((t) => t.cpu === vcpu && t.memory_mb === memoryMb) ||
  COMPUTE_TIERS.find((t) => t.memory_mb === memoryMb) ||
  COMPUTE_TIERS[0];

export const formatDurationSeconds = (seconds: number | null | undefined): string => {
  const s = Math.max(0, Math.floor(Number(seconds || 0)));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const m = mins % 60;
    return `${hrs}h ${String(m).padStart(2, "0")}m ${String(rem).padStart(2, "0")}s`;
  }
  return `${mins}m ${String(rem).padStart(2, "0")}s`;
};

export const formatCountdown = (seconds: number | null | undefined): string => {
  const s = Math.max(0, Math.floor(Number(seconds || 0)));
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(mins).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
};


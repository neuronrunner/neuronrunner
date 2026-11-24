/**
 * Random name generator for Virtual Machines.
 * Produces friendly, memorable two-word names (e.g. "swift-falcon", "cosmic-lynx")
 * instead of numeric IDs.
 */

export const VM_NAME_ADJECTIVES = [
  "agile", "amber", "arctic", "astral", "atomic",
  "autumn", "azure", "blazing", "bold", "brave",
  "breezy", "bright", "calm", "cedar", "clever",
  "coastal", "cosmic", "crimson", "crystal", "daring",
  "dawn", "echoing", "electric", "emerald", "fierce",
  "flaring", "frosty", "gentle", "gleaming", "golden",
  "harbor", "hyper", "infinite", "iron", "jade",
  "keen", "kinetic", "lightning", "lively", "lucid",
  "lunar", "mystic", "neon", "nimble", "noble",
  "nova", "ocean", "polar", "prime", "quantum",
  "quick", "radiant", "rapid", "rising", "ruby",
  "sapphire", "serene", "shadow", "sharp", "silent",
  "silver", "solar", "sonic", "spark", "stellar",
  "stormy", "sunset", "swift", "thunder", "tidal",
  "turbo", "valiant", "vibrant", "violet", "vivid",
  "wild", "windy", "wise", "zenith"
] as const;

export const VM_NAME_NOUNS = [
  "antelope", "apex", "apollo", "arrow", "atlas",
  "aurora", "badger", "beacon", "bison", "blazer",
  "breeze", "cascade", "cheetah", "cipher", "comet",
  "condor", "cortex", "crane", "crest", "cyclone",
  "dolphin", "drift", "eagle", "falcon", "feather",
  "flare", "fox", "glider", "harbor", "haven",
  "hawk", "horizon", "jaguar", "laser", "leopard",
  "lynx", "matrix", "meteor", "nexus", "nova",
  "oasis", "orbit", "orca", "otter", "panda",
  "panther", "phoenix", "photon", "pinnacle", "prism",
  "pulsar", "quasar", "raven", "ridge", "runner",
  "sailor", "satellite", "shadow", "spire", "summit",
  "tiger", "tracker", "trail", "vector", "vertex",
  "vessel", "vortex", "voyager", "wave", "whisper",
  "wolf", "zenith"
] as const;

/**
 * Generate a random memorable VM name.
 * Avoids duplicates when an iterable of existing names is provided.
 */
export function generateRandomVMName(existingNames: Iterable<string> = []): string {
  const existingSet = new Set(
    Array.from(existingNames)
      .map((n) => (typeof n === "string" ? n.trim().toLowerCase() : ""))
      .filter(Boolean),
  );

  // Try up to 25 random combinations to find one not already used
  for (let i = 0; i < 25; i++) {
    const adj = VM_NAME_ADJECTIVES[Math.floor(Math.random() * VM_NAME_ADJECTIVES.length)];
    const noun = VM_NAME_NOUNS[Math.floor(Math.random() * VM_NAME_NOUNS.length)];
    const candidate = `${adj}-${noun}`;
    if (!existingSet.has(candidate)) {
      return candidate;
    }
  }

  // Fallback if heavily populated: append a random 2-digit number
  const adj = VM_NAME_ADJECTIVES[Math.floor(Math.random() * VM_NAME_ADJECTIVES.length)];
  const noun = VM_NAME_NOUNS[Math.floor(Math.random() * VM_NAME_NOUNS.length)];
  const suffix = Math.floor(10 + Math.random() * 90);
  return `${adj}-${noun}-${suffix}`;
}

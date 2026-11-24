type RecentModel = Record<string, unknown>;

let cachedRecentModels: RecentModel[] | null = null;
let inflightRecentModelsRequest: Promise<RecentModel[]> | null = null;

export async function fetchRecentModels(token: string): Promise<RecentModel[]> {
  if (cachedRecentModels) {
    return cachedRecentModels;
  }

  if (inflightRecentModelsRequest) {
    return inflightRecentModelsRequest;
  }

  const request = fetch(`${env.API_URL}/recent-models/?limit=20`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch recent models: ${response.status}`);
      }

      const data = await response.json();
      const models = Array.isArray(data) ? data : [];
      cachedRecentModels = models;
      return models;
    })
    .finally(() => {
      inflightRecentModelsRequest = null;
    });

  inflightRecentModelsRequest = request;
  return request;
}

export function clearRecentModelsCache() {
  cachedRecentModels = null;
  inflightRecentModelsRequest = null;
}import { env } from "@/lib/env";

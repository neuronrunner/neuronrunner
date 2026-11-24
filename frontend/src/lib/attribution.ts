const ATTRIBUTION_KEY = "nr_signup_attribution";

export interface SignupAttribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  referrer?: string;
}

export function captureAttributionFromWindow(): void {
  if (typeof window === "undefined") return;
  try {
    const existingRaw = sessionStorage.getItem(ATTRIBUTION_KEY);
    const existing: SignupAttribution = existingRaw ? JSON.parse(existingRaw) : {};
    const params = new URLSearchParams(window.location.search);
    const utmSource = params.get("utm_source")?.trim();
    const utmMedium = params.get("utm_medium")?.trim();
    const utmCampaign = params.get("utm_campaign")?.trim();

    let referrerHost = "";
    if (document.referrer) {
      try {
        const refUrl = new URL(document.referrer);
        if (refUrl.hostname && refUrl.hostname !== window.location.hostname) {
          referrerHost = refUrl.hostname;
        }
      } catch {
        // ignore invalid referrer
      }
    }

    const merged: SignupAttribution = {
      utm_source: utmSource || existing.utm_source,
      utm_medium: utmMedium || existing.utm_medium,
      utm_campaign: utmCampaign || existing.utm_campaign,
      referrer: existing.referrer || referrerHost || undefined,
    };

    if (merged.utm_source || merged.utm_medium || merged.utm_campaign || merged.referrer) {
      sessionStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(merged));
    }
  } catch {
    // ignore storage errors
  }
}

export function getStoredAttribution(): SignupAttribution {
  if (typeof window === "undefined") return {};
  try {
    const raw = sessionStorage.getItem(ATTRIBUTION_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

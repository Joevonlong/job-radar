import type { DeepLinkConfig } from "@/lib/config/schemas/salary";

export interface DeepLinkValues {
  company: string;
  title: string;
  city: string | null;
  country: string | null;
}

export interface DeepLink {
  id: string;
  label: string;
  url: string;
}

/** "Acme Robotics GmbH" -> "acme-robotics-gmbh" (accents removed, other characters become dashes). */
export function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Fill the deep link templates of salary.yaml. Every value is URL-encoded; a template that needs a value the job does
 * not have (no city) is left out, and so is one whose result is not an http(s) URL.
 */
export function buildDeepLinks(templates: readonly DeepLinkConfig[], values: DeepLinkValues): DeepLink[] {
  const map: Record<string, string | null> = {
    company: values.company.trim() || null,
    company_slug: slugify(values.company) || null,
    title: values.title.trim() || null,
    city: values.city?.trim() || null,
    country: values.country?.trim() || null,
  };
  const out: DeepLink[] = [];
  for (const template of templates) {
    let missing = false;
    const url = template.url.replace(/\{([a-z_]+)\}/g, (_whole, name: string) => {
      const value = map[name];
      if (value === null || value === undefined) {
        missing = true;
        return "";
      }
      return encodeURIComponent(value);
    });
    if (missing) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    } catch {
      continue;
    }
    out.push({ id: template.id, label: template.label, url });
  }
  return out;
}

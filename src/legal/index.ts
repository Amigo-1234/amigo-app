import type { LegalSlug } from "../data";

/** The legal documents, in the order they're listed. Text ships with the app, one file per version. */
export const LEGAL_DOCS: { slug: LegalSlug; title: string; blurb: string }[] = [
  { slug: "terms", title: "Terms of Service", blurb: "The agreement for using Amigo" },
  { slug: "privacy", title: "Privacy Policy", blurb: "What we collect and why" },
  { slug: "guidelines", title: "Community Guidelines", blurb: "What's allowed on Amigo" },
  { slug: "copyright", title: "Copyright and Content Ownership", blurb: "Your content and others' rights" },
  { slug: "deletion", title: "Account Deletion and Data Retention", blurb: "Deleting your account and what we keep" },
  { slug: "cookies", title: "Cookie and Tracking Notice", blurb: "What's stored in your browser" },
  { slug: "monetization", title: "Monetization Programme Terms", blurb: "Creator monetization (coming soon)" },
];

/** The version shown when the backend can't say which is current (demo, offline). */
export const BUNDLED_VERSION: Record<LegalSlug, string> = {
  terms: "0.1",
  privacy: "0.1",
  guidelines: "0.1",
  copyright: "0.1",
  monetization: "0.1",
  deletion: "0.1",
  cookies: "0.1",
};

const files = import.meta.glob("./docs/*.md", { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;

/** The text of a document version, or null if this app build doesn't include it. */
export function loadLegalText(slug: LegalSlug, version: string): Promise<string | null> {
  const load = files[`./docs/${slug}-${version}.md`];
  return load ? load() : Promise.resolve(null);
}

/** 0.x versions are drafts awaiting legal review. */
export const isDraft = (version: string) => version.startsWith("0.");

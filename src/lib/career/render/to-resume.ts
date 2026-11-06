import { stringify } from "yaml";

import type { CareerContact } from "../schema/contact";
import type { CareerDocument } from "../schema/document";
import type { CareerImages } from "../store/images";
import { parseResume } from "../engine/render";
import type { Resume } from "../engine/schema";
import type { Images } from "../engine/images";
import { BUILTINS } from "../engine/sections";

export interface ProjectionIssue { path: string; code: string }
export class ResumeProjectionError extends Error {
  constructor(readonly issues: ProjectionIssue[]) {
    super("resume_projection_invalid");
  }
}
const optional = (fields: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));

const shown = <T extends { included: boolean }>(items: T[]) => items.filter((item) => item.included);
const texts = (items: CareerDocument["experience"][number]["bullets"]) =>
  items.filter((item) => item.included !== false).map((item) => item.text);

function resumeContent(document: CareerDocument) {
  const custom = shown(document.custom_sections)
    .filter((section) => shown(section.items).length > 0)
    .map((section) => ({
      id: section.id,
      value: {
        title: section.title.text, layout: section.layout, side: section.side,
        ...optional({ columns: section.columns }),
        items: shown(section.items).map((item) => item.kind === "entry" ? {
          heading: item.heading.text,
          ...optional({
            sub: item.sub?.text ?? null, url: item.url, date: item.date, start: item.start, end: item.end,
            location: item.location, text: item.text?.text ?? null,
          }),
          bullets: texts(item.bullets), tags: item.tags,
        } : item.kind === "text" ? { text: item.text.text } : item.text.text),
      },
    }));
  const customById = new Map(custom.filter((section) => section.id).map((section) => [section.id, section.value]));
  const referenced = new Set(document.layout.sections?.flatMap((ref) => typeof ref === "string" ? [] : [ref.custom]));
  const sections = document.layout.sections === null
    ? (custom.length ? [...BUILTINS, ...custom.map((section) => section.value)] : undefined)
    : [
      ...document.layout.sections.flatMap<unknown>((ref) => {
        if (typeof ref === "string") return [ref];
        const section = customById.get(ref.custom);
        return section ? [section] : [];
      }),
      ...custom.filter((section) => !referenced.has(section.id)).map((section) => section.value),
    ];
  return {
    experience: shown(document.experience).map((entry) => ({
      company: entry.company, role: entry.role.text, stack: entry.stack, bullets: texts(entry.bullets),
      ...optional({
        url: entry.url, location: entry.location, start: entry.start, end: entry.end,
        summary: entry.summary?.text ?? null,
      }),
    })),
    projects: shown(document.projects).map((entry) => ({
      name: entry.name, stack: entry.stack, bullets: texts(entry.bullets),
      ...optional({ url: entry.url, tagline: entry.tagline?.text ?? null }),
    })),
    education: shown(document.education).map((entry) => ({
      school: entry.school, degree: entry.degree.text, bullets: texts(entry.bullets),
      ...optional({
        location: entry.location, start: entry.start, end: entry.end, summary: entry.summary?.text ?? null,
      }),
    })),
    certifications: shown(document.certifications).map((entry) => ({
      name: entry.name, ...optional({ issuer: entry.issuer, date: entry.date }),
    })),
    languages: shown(document.languages).map((entry) => ({ name: entry.name, level: entry.level })),
    skills: shown(document.skills).map((group) => ({
      group: group.group, items: shown(group.items).map((item) => item.name),
    })),
    approach: shown(document.approach).map((entry) => ({ title: entry.title, text: entry.text.text })),
    ...(sections ? { sections } : {}),
  };
}

function addressLines(address: string | null): string[] | null {
  if (address === null) return null;
  const lines = address.split(/\r?\n/).filter((line) => line.trim());
  return lines.length > 2 ? [lines[0]!, lines.slice(1).join(", ")] : lines;
}

/** Contact and image bytes enter the transient rendering model only at this boundary. */
export function toResume(
  document: CareerDocument, contact: CareerContact, images: CareerImages, doc: "resume" | "letter",
): { resume: Resume; images: Images } {
  const hidden = new Set(document.hide_contact);
  const renderedImages: Images = {};
  if (doc === "resume" && images.photo && !hidden.has("photo")) renderedImages.photo = images.photo;
  const signature = document.layout.signature !== null ? {
    date: document.layout.signature.date,
    ...optional({ place: document.layout.signature.place }),
    ...(images.signature ? { image: "signature" } : {}),
  } : null;
  const letterBody = doc === "letter" && document.letter ? texts(document.letter.body) : [];
  const letterSignature = images.signature && letterBody.length ? "signature" : null;
  if (images.signature && (signature !== null || letterSignature !== null)) renderedImages.signature = images.signature;
  const raw = {
    meta: {
      lang: document.layout.lang, theme: document.layout.theme, accent: document.layout.accent,
      pages: document.layout.pages, paper: document.layout.paper,
      density: document.layout.density, colors: document.layout.colors,
      ...optional({ filename: document.layout.filename, signature }),
    },
    basics: {
      name: contact.name ?? "", title: document.headline?.text ?? "",
      ...optional({ summary: document.summary?.text ?? null }),
      ...Object.fromEntries((["location", "address", "email", "phone", "work_auth", "availability", "links"] as const)
        .filter((key) => !hidden.has(key) && contact[key] !== null)
        .map((key) => [
          key === "work_auth" ? "workAuth" : key,
          key === "address" ? addressLines(contact.address) : contact[key],
        ])),
      ...(renderedImages.photo ? { photo: "photo" } : {}),
    },
    ...(doc === "resume" ? resumeContent(document) : {}),
    ...(document.letter && letterBody.length ? { letter: {
      body: letterBody,
      ...(document.letter.recipient.length ? { recipient: document.letter.recipient } : {}),
      ...optional({
        place: document.letter.place, date: document.letter.date, subject: document.letter.subject,
        salutation: document.letter.salutation, closing: document.letter.closing, signature: letterSignature,
      }),
    } } : {}),
  };
  const result = parseResume(stringify(raw));
  if (!result.ok) throw new ResumeProjectionError(result.issues.map(({ path, code }) => ({ path, code })));
  return { resume: result.resume, images: renderedImages };
}

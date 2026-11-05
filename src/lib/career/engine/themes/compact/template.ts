import { customBody, joinSep, letterBody, placeLine, signOff, tags } from "../../blocks";
import type { Kit } from "../../blocks";
import { anchor, bareUrl, esc, md, safeHref } from "../../md";
import { resolveSections } from "../../sections";
import type { BuiltinName } from "../../sections";
import type { Resume } from "../../schema";
import type { Ctx, Theme } from "../../theme";

function letterhead(r: Resume, ctx: Ctx, letter = false): string {
  const b = r.basics;
  const { photoUrl } = ctx;
  const home = placeLine(b);
  const contact = joinSep([
    b.email && `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>`,
    b.phone && esc(b.phone),
    home && esc(home),
    b.workAuth && esc(b.workAuth),
    ...b.links.map((l) => anchor(l.url, esc(bareUrl(l.url)))),
  ]);

  const header = `<header>
  <div class="id">
    <h1>${esc(b.name)}</h1>
    <p class="title">${esc(b.title)}</p>
    ${contact ? `<p class="contact">${contact}</p>` : ""}${!letter && b.availability ? `<p class="contact avail">${esc(ctx.availability(b.availability))}</p>` : ""}
  </div>
  ${photoUrl ? `<img class="photo" src="${photoUrl}" alt="">` : ""}
</header>`;

  return header;
}

const theme: Theme = {
  fonts: [
    { family: "IBM Plex Sans", weight: 400 },
    { family: "IBM Plex Sans", weight: 500 },
    { family: "IBM Plex Sans", weight: 600 },
    { family: "IBM Plex Mono", weight: 400 },
  ],
  render(r, ctx) {
    const { t, range, date } = ctx;
    const b = r.basics;
    const section = (label: string, body: string, cls = "") =>
      body ? `<section${cls ? ` class="${cls}"` : ""}><h2>${esc(label)}</h2>${body}</section>` : "";
    const bullets = (xs: string[]) => (xs.length ? `<ul class="bullets">${xs.map((x) => `<li><span>${md(x)}</span></li>`).join("")}</ul>` : "");
    const stack = (xs: string[]) => (xs.length ? `<p class="stack">${joinSep(xs.map(esc))}</p>` : "");

    const head = (what: string, parts: (string | false | undefined)[], when?: string) =>
      `<div class="head"><div class="what"><h3>${what}</h3>${parts.filter(Boolean).length ? `<span class="sep">&nbsp;· </span>${joinSep(parts)}` : ""}</div>${when ? `<span class="when">${when}</span>` : ""}</div>`;

    const header = letterhead(r, ctx);

    const org = (name: string, url?: string) => `<span class="org">${url ? anchor(url, esc(name)) : esc(name)}</span>`;
    const place = (s?: string) => s && `<span class="place">${esc(s)}</span>`;

    const approach = r.approach.length
      ? `<ul class="bullets approach">${r.approach.map((a) => `<li><span><strong>${esc(a.title)}.</strong> ${md(a.text)}</span></li>`).join("")}</ul>`
      : "";

    const experience = r.experience
      .map(
        (e) => `<article class="entry">
  ${head(esc(e.role), [org(e.company, e.url), place(e.location)], range(e.start, e.end))}
  ${e.summary ? `<p class="summary">${md(e.summary)}</p>` : ""}
  ${bullets(e.bullets)}${stack(e.stack)}
</article>`,
      )
      .join("");

    const projects = r.projects
      .map(
        (p) => `<article class="entry">
  ${head(esc(p.name), [p.tagline && `<span class="org">${esc(p.tagline)}</span>`], p.url ? anchor(p.url, esc(bareUrl(p.url))) : undefined)}
  ${bullets(p.bullets)}${stack(p.stack)}
</article>`,
      )
      .join("");

    const skills = r.skills.length
      ? `<ul class="lines">${r.skills.map((s) => `<li><strong>${esc(s.group)}:</strong> ${s.items.map(esc).join(", ")}</li>`).join("")}</ul>`
      : "";

    const education = r.education
      .map(
        (e) => `<article class="entry">
  ${head(esc(e.degree), [org(e.school), place(e.location)], range(e.start, e.end))}
  ${e.summary ? `<p class="summary">${md(e.summary)}</p>` : ""}${bullets(e.bullets)}
</article>`,
      )
      .join("");

    const certs = r.certifications.length
      ? `<div class="rows">${r.certifications.map((c) => head(esc(c.name), [c.issuer && `<span class="org">${esc(c.issuer)}</span>`], c.date && date(c.date))).join("")}</div>`
      : "";
    const languages = r.languages.length
      ? `<p class="langs">${joinSep(r.languages.map((l) => `<span><strong>${esc(l.name)}</strong> ${esc(l.level)}</span>`))}</p>`
      : "";

    const kit: Kit = {
      bullets,
      entry: (e) => {
        const href = e.url && safeHref(e.url);
        const heading = href ? `<a href="${esc(href)}">${esc(e.heading)}</a>` : esc(e.heading);
        return `<article class="entry">
  ${head(heading, [e.sub && `<span class="org">${esc(e.sub)}</span>`, place(e.location)], e.start && range(e.start, e.end))}
  ${e.text ? `<p class="summary">${md(e.text)}</p>` : ""}
  ${bullets(e.bullets)}${tags(e.tags)}
</article>`;
      },
    };

    const builtin: Record<BuiltinName, string> = {
      summary: section(t.summary, b.summary ? `<p class="lead">${md(b.summary)}</p>` : ""),
      approach: section(t.approach, approach),
      experience: section(t.experience, experience),
      projects: section(t.projects, projects),
      skills: section(t.skills, skills),
      education: section(t.education, education),
      certifications: section(t.certifications, certs),
      languages: section(t.languages, languages),
    };

    const body = resolveSections(r).map((s) => (s.kind === "builtin" ? builtin[s.name] : section(s.title, customBody(s, kit), "custom")));

    const sign = signOff(r, ctx);
    return `<main class="page">
${header}
${body.join("\n")}${sign ? `\n${sign}` : ""}
</main>`;
  },

  letter(r, ctx) {
    return `<main class="page letter">
${letterhead(r, ctx, true)}
${letterBody(r, ctx)}
</main>`;
  },
};

export default theme;

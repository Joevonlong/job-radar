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
  const contact = [
    joinSep([b.email && `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>`, b.phone && esc(b.phone), home && esc(home), b.workAuth && esc(b.workAuth)]),
    joinSep(b.links.map((l) => anchor(l.url, esc(bareUrl(l.url))))),
    !letter && b.availability && `<span class="avail">${esc(ctx.availability(b.availability))}</span>`,
  ].filter(Boolean);

  const header = `<header class="band">
  <div class="id">
    <h1>${esc(b.name)}</h1>
    <p class="title">${esc(b.title)}</p>
    ${contact.map((c) => `<p class="contact">${c}</p>`).join("")}
  </div>
  ${photoUrl ? `<img class="photo" src="${photoUrl}" alt="">` : ""}
</header>`;

  return header;
}

const theme: Theme = {
  fonts: [{ family: "Inter", weight: 400 }, { family: "Inter", weight: 500 }, { family: "Inter", weight: 600 }, { family: "Inter", weight: 700 }, { family: "IBM Plex Mono", weight: 400 }],
  render(r, ctx) {
    const { t, range, date } = ctx;
    const b = r.basics;
    const section = (label: string, body: string, cls = "") =>
      body ? `<section${cls ? ` class="${cls}"` : ""}><h2>${esc(label)}</h2>${body}</section>` : "";
    const bullets = (xs: string[]) => (xs.length ? `<ul class="bullets">${xs.map((x) => `<li><span>${md(x)}</span></li>`).join("")}</ul>` : "");
    const stack = (xs: string[]) => (xs.length ? `<p class="stack">${joinSep(xs.map(esc))}</p>` : "");

    const head = (what: string, when?: string, org?: string, place?: string) => {
      const rest = joinSep([org && `<span class="name">${org}</span>`, place && `<span class="place">${esc(place)}</span>`]);
      return `<div class="head"><div class="what"><h3>${what}</h3>${rest ? `<span class="sep">&nbsp;· </span>${rest}` : ""}</div>${when ? `<span class="when">${when}</span>` : ""}</div>`;
    };

    const header = letterhead(r, ctx);

    const approach = r.approach.length
      ? `<ol class="approach">${r.approach.map((a, i) => `<li><span class="n">${String(i + 1).padStart(2, "0")}</span><div><h3>${esc(a.title)}</h3><p>${md(a.text)}</p></div></li>`).join("")}</ol>`
      : "";

    const experience = r.experience
      .map(
        (e) => `<article class="entry">
  ${head(esc(e.role), range(e.start, e.end), e.url ? anchor(e.url, esc(e.company)) : esc(e.company), e.location)}
  ${e.summary ? `<p class="summary">${md(e.summary)}</p>` : ""}
  ${bullets(e.bullets)}${stack(e.stack)}
</article>`,
      )
      .join("");

    const projects = r.projects
      .map(
        (p) => `<article class="entry">
  ${head(esc(p.name), p.url ? anchor(p.url, esc(bareUrl(p.url))) : undefined, p.tagline && esc(p.tagline))}
  ${bullets(p.bullets)}${stack(p.stack)}
</article>`,
      )
      .join("");

    const skills = r.skills.length
      ? `<dl class="skills">${r.skills.map((s) => `<dt>${esc(s.group)}</dt><dd>${s.items.map(esc).join(", ")}</dd>`).join("")}</dl>`
      : "";

    const education = r.education
      .map(
        (e) => `<article class="entry">
  ${head(esc(e.degree), range(e.start, e.end), esc(e.school), e.location)}
  ${e.summary ? `<p class="summary">${md(e.summary)}</p>` : ""}${bullets(e.bullets)}
</article>`,
      )
      .join("");

    const certs = r.certifications.length
      ? `<ul class="facts">${r.certifications.map((c) => `<li><span class="fact">${esc(c.name)}</span>${c.issuer || c.date ? `<span class="sep">&nbsp;· </span><span class="muted">${joinSep([c.issuer && esc(c.issuer), c.date && date(c.date)])}</span>` : ""}</li>`).join("")}</ul>`
      : "";
    const languages = r.languages.length
      ? `<p class="langs">${joinSep(r.languages.map((l) => `<span><span class="fact">${esc(l.name)}</span> <span class="muted">${esc(l.level)}</span></span>`))}</p>`
      : "";

    const kit: Kit = {
      bullets,
      entry: (e) => {
        const href = e.url && safeHref(e.url);
        const heading = href ? `<a href="${esc(href)}">${esc(e.heading)}</a>` : esc(e.heading);
        return `<article class="entry">
  ${head(heading, e.start && range(e.start, e.end), e.sub && esc(e.sub), e.location)}
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
<div class="content">
${body.join("\n")}${sign ? `\n${sign}` : ""}
</div>
</main>`;
  },

  letter(r, ctx) {
    return `<main class="page letter">
${letterhead(r, ctx, true)}
<div class="content">
${letterBody(r, ctx)}
</div>
</main>`;
  },
};

export default theme;

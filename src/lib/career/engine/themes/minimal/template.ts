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

  const place = placeLine(b);
  const contact = [
    place && esc(place),
    b.workAuth && `<span class="auth">${esc(b.workAuth)}</span>`,
    b.email && `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>`,
    b.phone && esc(b.phone),
  ].filter(Boolean);
  const links = b.links.map((l) => anchor(l.url, esc(bareUrl(l.url))));
  const line = (items: (string | undefined | false)[]) =>
    items.length ? `<p class="contact">${items.map((x) => `<span>${x}</span>`).join("<i>·</i>")}</p>` : "";

  const header = `<header>
  <div class="id">
    <h1>${esc(b.name)}</h1>
    <p class="title"><span class="chev" aria-hidden="true"></span>${esc(b.title)}</p>
    ${line(contact)}${line(links)}${!letter && b.availability ? `<p class="contact avail"><span>${esc(ctx.availability(b.availability))}</span></p>` : ""}
  </div>
  ${photoUrl ? `<img class="photo" src="${photoUrl}" alt="">` : ""}
</header>`;

  return header;
}

const theme: Theme = {
  fonts: [
    { family: "Inter", weight: 400 },
    { family: "Inter", weight: 500 },
    { family: "Inter", weight: 600 },
    { family: "Newsreader", weight: 500 },
    { family: "IBM Plex Mono", weight: 400 },
  ],
  render(r, ctx) {
    const { t, range, date } = ctx;
    const b = r.basics;
    const section = (label: string, body: string, cls = "") =>
      body ? `<section${cls ? ` class="${cls}"` : ""}><h2>${esc(label)}</h2><div class="body">${body}</div></section>` : "";
    const bullets = (xs: string[]) => (xs.length ? `<ul class="bullets">${xs.map((x) => `<li><span>${md(x)}</span></li>`).join("")}</ul>` : "");

    const stack = (xs: string[]) => (xs.length ? `<p class="stack">${joinSep(xs.map(esc))}</p>` : "");

    const org = (html: string) => `<span class="dash">&nbsp;— </span><span class="org">${html}</span>`;

    const meta = (when?: string, where?: string) =>
      when || where ? `<p class="meta">${joinSep([where && `<span class="where">${esc(where)}</span>`, when && `<span class="when">${when}</span>`])}</p>` : "";

    const header = letterhead(r, ctx);

    const approach = r.approach.length
      ? `<ol class="approach">${r.approach.map((a) => `<li><h3>${esc(a.title)}</h3><p>${md(a.text)}</p></li>`).join("")}</ol>`
      : "";

    const experience = r.experience
      .map(
        (e) => `<article class="entry">
  <div class="head"><h3>${esc(e.role)}${org(e.url ? anchor(e.url, esc(e.company)) : esc(e.company))}</h3>${meta(range(e.start, e.end), e.location)}</div>
  ${e.summary ? `<p class="summary">${md(e.summary)}</p>` : ""}
  ${bullets(e.bullets)}${stack(e.stack)}
</article>`,
      )
      .join("");

    const projects = r.projects
      .map(
        (p) => `<article class="entry">
  <div class="head"><h3>${esc(p.name)}${p.tagline ? org(esc(p.tagline)) : ""}</h3>${p.url ? `<p class="meta">${anchor(p.url, esc(bareUrl(p.url)), "when")}</p>` : ""}</div>
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
  <div class="head"><h3>${esc(e.degree)}${org(esc(e.school))}</h3>${meta(range(e.start, e.end), e.location)}</div>
  ${e.summary ? `<p class="summary">${md(e.summary)}</p>` : ""}${bullets(e.bullets)}
</article>`,
      )
      .join("");

    const certs = r.certifications.length
      ? `<ul class="certs">${r.certifications
          .map((c) => `<li>${joinSep([esc(c.name), c.issuer && `<span class="muted">${esc(c.issuer)}</span>`, c.date && `<span class="muted">${date(c.date)}</span>`])}</li>`)
          .join("")}</ul>`
      : "";
    const languages = r.languages.length
      ? `<p class="langs">${joinSep(r.languages.map((l) => `<span>${esc(l.name)} <span class="muted">${esc(l.level)}</span></span>`))}</p>`
      : "";

    const kit: Kit = {
      bullets,
      entry: (e) => {
        const href = e.url && safeHref(e.url);
        const heading = href ? `<a href="${esc(href)}">${esc(e.heading)}</a>` : esc(e.heading);
        return `<article class="entry">
  <div class="head"><h3>${heading}${e.sub ? org(esc(e.sub)) : ""}</h3>${meta(e.start && range(e.start, e.end), e.location)}</div>
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

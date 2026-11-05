import { customBody, joinSep, letterBody, signOff, tags, urlText } from "../../blocks";
import type { Kit } from "../../blocks";
import { anchor, bareUrl, esc, md, safeHref } from "../../md";
import { resolveSections } from "../../sections";
import type { BuiltinName } from "../../sections";
import type { Resume } from "../../schema";
import type { Ctx, Theme } from "../../theme";

function letterhead(r: Resume, ctx: Ctx, letter = false): string {
  const b = r.basics;
  const { photoUrl } = ctx;

  const avail = !letter && b.availability && `<span class="avail">${esc(ctx.availability(b.availability))}</span>`;
  const lines = [
    ...(b.address ?? []).map(esc),
    joinSep([b.phone && esc(b.phone), b.email && `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>`]),
    !b.address && joinSep([b.location && esc(b.location), b.workAuth && esc(b.workAuth)]),
    joinSep(b.links.map((l) => anchor(l.url, urlText(bareUrl(l.url))))),
    joinSep([b.address && b.workAuth && esc(b.workAuth), avail]),
  ].filter(Boolean);

  const header = `<header${photoUrl ? ` class="with-photo"` : ""}>
  <h1>${esc(b.name)}</h1>
  <p class="title">${esc(b.title)}</p>
  <div class="contact">${lines.map((l) => `<p>${l}</p>`).join("")}</div>
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
    { family: "Newsreader", weight: 600 },
    { family: "IBM Plex Mono", weight: 400 },
  ],
  render(r, ctx) {
    const { t, range, date } = ctx;
    const b = r.basics;
    const section = (label: string, body: string, cls = "") =>
      body ? `<section${cls ? ` class="${cls}"` : ""}><h2>${esc(label)}</h2>${body}</section>` : "";
    const bullets = (xs: string[]) => (xs.length ? `<ul class="bullets">${xs.map((x) => `<li><span>${md(x)}</span></li>`).join("")}</ul>` : "");
    const stack = (xs: string[]) => (xs.length ? `<p class="stack">${xs.map(esc).join(", ")}</p>` : "");

    const row = (left: string, right: string, cls = "") => `<div class="row${cls ? ` ${cls}` : ""}"><div class="l">${left}</div><div class="r">${right}</div></div>`;

    const when = (period?: string, place?: string) =>
      (period ? `<span class="when">${period}</span>` : "") + (place ? `<span class="where">${esc(place)}</span>` : "");

    const head = (what: string, org?: string) => `<h3>${what}${org ? ` <span class="org">— ${org}</span>` : ""}</h3>`;

    const header = letterhead(r, ctx);

    const approach = r.approach.length ? `<ul class="approach">${r.approach.map((a) => `<li><strong>${esc(a.title)}.</strong> ${md(a.text)}</li>`).join("")}</ul>` : "";

    const experience = r.experience
      .map((e) =>
        row(
          when(range(e.start, e.end), e.location),
          `${head(esc(e.role), e.url ? anchor(e.url, esc(e.company)) : esc(e.company))}${e.summary ? `<p class="summary">${md(e.summary)}</p>` : ""}${bullets(e.bullets)}${stack(e.stack)}`,
          "entry",
        ),
      )
      .join("");

    const projects = r.projects
      .map((p) =>
        row(

          "",
          `${head(esc(p.name), p.tagline && esc(p.tagline))}${p.url ? `<p class="link">${anchor(p.url, urlText(bareUrl(p.url)))}</p>` : ""}${bullets(p.bullets)}${stack(p.stack)}`,
          "entry",
        ),
      )
      .join("");

    const skills = r.skills.length
      ? `<div class="table">${r.skills.map((s) => row(`<span class="label">${esc(s.group)}</span>`, `<p>${s.items.map(esc).join(", ")}</p>`)).join("")}</div>`
      : "";

    const education = r.education
      .map((e) =>
        row(
          when(range(e.start, e.end), e.location),
          `${head(esc(e.degree), esc(e.school))}${e.summary ? `<p class="summary">${md(e.summary)}</p>` : ""}${bullets(e.bullets)}`,
          "entry",
        ),
      )
      .join("");

    const certs = r.certifications
      .map((c) => row(when(c.date && date(c.date)), `<p><span class="cert">${esc(c.name)}</span>${c.issuer ? `<span class="place">, ${esc(c.issuer)}</span>` : ""}</p>`, "fact"))
      .join("");

    const languages = r.languages.length
      ? `<p class="langs">${joinSep(r.languages.map((l) => `<span><span class="label">${esc(l.name)}</span> ${esc(l.level)}</span>`))}</p>`
      : "";

    const kit: Kit = {
      bullets,
      entry: (e) => {
        const href = e.url && safeHref(e.url);
        const heading = href ? `<a href="${esc(href)}">${esc(e.heading)}</a>` : esc(e.heading);
        return row(
          when(e.start && range(e.start, e.end), e.location),
          `${head(heading, e.sub && esc(e.sub))}${e.text ? `<p class="summary">${md(e.text)}</p>` : ""}${bullets(e.bullets)}${tags(e.tags)}`,
          "entry",
        );
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

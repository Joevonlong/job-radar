import { customBody, joinSep, letterBody, placeLine, signOff, tags, urlText } from "../../blocks";
import type { Kit } from "../../blocks";
import { anchor, bareUrl, esc, md, safeHref } from "../../md";
import { resolveSections } from "../../sections";
import type { BuiltinName } from "../../sections";
import type { Theme } from "../../theme";

const ASIDE_BUILTINS: BuiltinName[] = ["skills", "education", "certifications", "languages"];

const theme: Theme = {
  fonts: [
    { family: "IBM Plex Sans", weight: 400 },
    { family: "IBM Plex Sans", weight: 500 },
    { family: "IBM Plex Sans", weight: 600 },
    { family: "IBM Plex Mono", weight: 400 },
    { family: "IBM Plex Mono", weight: 500 },
  ],
  render(r, ctx) {
    const { t, range, date, photoUrl } = ctx;
    const b = r.basics;
    const block = (label: string, body: string, cls = "") =>
      body ? `<section class="${cls}"><h2>${esc(label)}</h2>${body}</section>` : "";
    const bullets = (xs: string[]) => (xs.length ? `<ul class="bullets">${xs.map((x) => `<li><span>${md(x)}</span></li>`).join("")}</ul>` : "");

    const chips = (xs: string[]) =>
      xs.length
        ? `<p class="chips">${xs.map((x, i) => `<span class="unit"><span class="chip">${esc(x)}</span>${i < xs.length - 1 ? `<span class="sep"> · </span>` : ""}</span>`).join("")}</p>`
        : "";

    const contact = [
      b.email && `<li><a href="mailto:${esc(b.email)}">${esc(b.email)}</a></li>`,
      b.phone && `<li>${esc(b.phone)}</li>`,
      b.address ? `<li class="addr">${b.address.map(esc).join("<br>")}</li>` : b.location && `<li>${esc(b.location)}</li>`,
      b.workAuth && `<li class="auth">${esc(b.workAuth)}</li>`,
      b.availability && `<li class="avail">${esc(ctx.availability(b.availability))}</li>`,
      ...b.links.map((l) => `<li>${anchor(l.url, urlText(bareUrl(l.url)))}</li>`),
    ].filter(Boolean);

    const skills = r.skills
      .map((s) => `<div class="skill"><h3>${esc(s.group)}</h3><p>${joinSep(s.items.map(esc))}</p></div>`)
      .join("");

    const education = r.education
      .map(

        (e) =>
          `<div class="fact"><h3>${esc(e.degree)}</h3><p class="org">${esc(e.school)}</p><p class="mono">${joinSep([range(e.start, e.end), e.location && esc(e.location)])}</p>${e.summary ? `<p class="muted">${md(e.summary)}</p>` : ""}${bullets(e.bullets)}</div>`,
      )
      .join("");

    const certs = r.certifications
      .map((c) => `<div class="fact"><h3>${esc(c.name)}</h3><p class="muted">${joinSep([c.issuer && esc(c.issuer), c.date && date(c.date)])}</p></div>`)
      .join("");

    const languages = r.languages.length
      ? `<dl class="langs">${r.languages.map((l) => `<dt>${esc(l.name)}</dt><dd>${esc(l.level)}</dd>`).join("")}</dl>`
      : "";

    const approach = r.approach.length
      ? `<ol class="approach">${r.approach.map((a, i) => `<li><span class="n">${String(i + 1).padStart(2, "0")}</span><div><h3>${esc(a.title)}</h3> <p>${md(a.text)}</p></div></li>`).join("")}</ol>`
      : "";

    const experience = r.experience
      .map(
        (e) => `<article class="entry">
  <div class="head"><h3>${esc(e.role)}</h3><span class="mono">${range(e.start, e.end)}</span></div>
  <p class="org">${e.url ? anchor(e.url, esc(e.company)) : esc(e.company)}${e.location ? `<span class="muted"> · ${esc(e.location)}</span>` : ""}</p>
  ${e.summary ? `<p class="muted">${md(e.summary)}</p>` : ""}
  ${bullets(e.bullets)}${chips(e.stack)}
</article>`,
      )
      .join("");

    const projects = r.projects
      .map(
        (p) => `<article class="entry">
  <div class="head"><h3>${esc(p.name)}</h3>${p.url ? anchor(p.url, esc(bareUrl(p.url)), "mono") : ""}</div>
  ${p.tagline ? `<p class="org">${esc(p.tagline)}</p>` : ""}
  ${bullets(p.bullets)}${chips(p.stack)}
</article>`,
      )
      .join("");

    const kit: Kit = {
      bullets,
      entry: (e) => {
        const href = e.url && safeHref(e.url);
        const heading = href ? `<a href="${esc(href)}">${esc(e.heading)}</a>` : esc(e.heading);
        const org = [e.sub && esc(e.sub), e.location && `<span class="muted">${e.sub ? " · " : ""}${esc(e.location)}</span>`].filter(Boolean).join("");
        return `<article class="entry">
  <div class="head"><h3>${heading}</h3>${e.start ? `<span class="mono">${range(e.start, e.end)}</span>` : ""}</div>
  ${org ? `<p class="org">${org}</p>` : ""}
  ${e.text ? `<p class="muted">${md(e.text)}</p>` : ""}
  ${bullets(e.bullets)}${tags(e.tags)}
</article>`;
      },
    };

    const builtin: Record<BuiltinName, string> = {
      summary: "",
      approach: block(t.approach, approach),
      experience: block(t.experience, experience),
      projects: block(t.projects, projects),
      skills: block(t.skills, skills),
      education: block(t.education, education),
      certifications: block(t.certifications, certs),
      languages: block(t.languages, languages),
    };

    const sections = resolveSections(r);
    const inAside = (name: BuiltinName) => ASIDE_BUILTINS.includes(name);
    const html = (s: (typeof sections)[number]) => (s.kind === "builtin" ? builtin[s.name] : block(s.title, customBody(s, kit), "custom"));
    const aside = sections.filter((s) => (s.kind === "builtin" ? inAside(s.name) : s.side === "aside")).map(html);
    const main = sections.filter((s) => (s.kind === "builtin" ? s.name !== "summary" && !inAside(s.name) : s.side === "main")).map(html);
    const lead = b.summary && sections.some((s) => s.kind === "builtin" && s.name === "summary") ? `<p class="lead">${md(b.summary)}</p>` : "";
    const sign = signOff(r, ctx);

    return `<main class="page">
<div class="main">
  ${[
    `<header>
    <h1>${esc(b.name)}</h1>
    <p class="title"><span class="chev" aria-hidden="true"></span>${esc(b.title)}</p>
    ${lead}
  </header>`,
    ...main,
    ...(sign ? [sign] : []),
  ].join("\n  ")}
</div>
<aside>
  ${[photoUrl ? `<img class="photo" src="${photoUrl}" alt="">` : "", block(t.contact, `<ul class="contact">${contact.join("")}</ul>`), ...aside].join("\n  ")}
</aside>
</main>`;
  },

  letter(r, ctx) {
    const b = r.basics;
    const place = placeLine(b);

    const lines = [
      joinSep([place && esc(place), b.phone && esc(b.phone), b.email && `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>`]),
      joinSep(b.links.map((l) => anchor(l.url, esc(bareUrl(l.url))))),
    ].filter(Boolean);
    return `<main class="page letter">
<header>
  <h1>${esc(b.name)}</h1>
  <p class="title"><span class="chev" aria-hidden="true"></span>${esc(b.title)}</p>
  ${lines.map((l) => `<p class="contact">${l}</p>`).join("")}
</header>
${letterBody(r, ctx)}
</main>`;
  },
};

export default theme;

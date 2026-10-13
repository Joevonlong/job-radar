// @vitest-environment node
import { describe, expect, it } from "vitest";

import { evergreenWording } from "@/lib/ghost/signals";

import { fixtureRules, rulesWith } from "./helpers";

/**
 * Adversarial sentences against the fixture packs (generic + de): which evergreen pattern counts, or null. The fixture packs are a
 * copy of the shipped ones' ghost section; nothing here reads config/.
 */
const CASES: ReadonlyArray<readonly [string, string | null]> = [
  // EN
  ["This posting is for our talent pool.", "talent_pool"],
  ["This is not a talent pool posting; we are hiring for one specific team.", null],
  ["We are hiring for a specific role in our Berlin office. Not a talent pool posting.", null],
  ["We are building talent pool software for HR teams.", null],
  ["Our platform helps companies grow their talent pipelines.", null],
  ["You will build and nurture our talent pipeline.", null],
  ["Your tasks:\n- Build our talent pool\n- Run interviews", null],
  ["Don't see a role that fits? Join our talent community.", null],
  ["Don't see a role that fits?\nJoin our talent community.", null],
  ["Your application may also be considered for future roles.", null],
  ["If there is no open role right now, we keep your CV.", null],
  ["We are always hiring great people.", "always_hiring"],
  ["We are always looking for engineers who love Rust.", null],
  ["There is no current opening, but we collect applications for future openings.", "no_specific_opening"],
  ["This is an evergreen role.", "evergreen_posting"],
  ["Talent pool\nThis posting is not for a specific opening.", "no_specific_opening"],
  ["We are not always hiring, but right now we need a senior engineer.", null],
  ["Talent pool\nWe are hiring one backend engineer for the payments team.", null],
  ["What this role is not\n- a talent pool posting\n- a contract role", null],
  ["What this role is not:\n- a talent pool posting\n- a contract role", null],
  ["Joining our talent community is not required to apply.", null],
  ["Acme is the leading talent community platform for engineers.", null],
  ["We help recruiters turn applicants into the talent pool they need.", null],
  ["Our ATS lets hiring managers add candidates to the talent pipeline.", null],
  ["Our app alerts users about future openings at their favourite companies.", null],
  ["Join our Talent Network team as a Recruiter in Berlin.", null],
  ["We are always recruiting for our internal talent pool, but this role is a concrete opening in Munich.", null],
  ["There are no current openings in our Paris office; this role is based in Berlin.", null],
  ["Not ready to apply? Join our talent community to stay in touch.", null],
  ["Want to hear about new roles?\nJoin our talent community.", null],
  ["We're always looking for people who are passionate about climate.", null],
  ["This role is not for our talent pool.", null],
  ["We are always recruiting for our talent pool.", "always_hiring"],
  ["¿No ves un puesto? Join our talent community.", "talent_pool"],
  // DE
  ["Diese Ausschreibung dient dem Aufbau unseres Talentpools.", "talent_pool"],
  ["Diese Stelle dient nicht dem Aufbau eines Talentpools.", null],
  ["Für unseren Talentpool suchen wir derzeit nicht.", null],
  ["Für unseren Talentpool ist diese Stellenanzeige ganz ausdrücklich nicht gedacht.", null],
  ["Wir suchen ständig nach neuen Wegen, unsere Kunden zu begeistern.", null],
  ["Wir stellen ständig neue Anforderungen an unsere Produkte.", null],
  ["Was wir nicht sind\n- ein Talentpool für zukünftige Stellen\n- eine Zeitarbeitsfirma", null],
  ["Wir bauen eine Plattform für den Talentpool-Aufbau von Mittelständlern.", null],
  ["Die Stelle ist unbefristet und zukünftige Kollegen freuen sich auf dich.", null],
  ["Die Stelle gilt als Sprungbrett für zukünftige Führungsaufgaben.", null],
  ["Diese Stelle ist keine Initiativbewerbung, sondern eine konkrete Vakanz.", null],
  ["Wir sind ein Personaldienstleister und suchen laufend für unsere Kunden.", "always_hiring"],
  ["Wir suchen ständig neue Kolleginnen und Kollegen.", "always_hiring"],
  ["Wir stellen das ganze Jahr über neue Mitarbeitende ein.", "always_hiring"],
  ["Die Ausschreibung richtet sich an zukünftige Vakanzen.", "open_application"],
  ["Noch nicht bereit? Bleib in Kontakt über unseren Talentpool.", null],
  ["Dies ist keine Ausschreibung für unseren Talentpool, sondern eine konkrete Stelle im Team Data.", null],
  ["Wir helfen Unternehmen beim Aufbau ihres Talentpools.", null],
  ["Du bist verantwortlich für den Aufbau unseres Talentpools.", null],
  ["Keine passende Stelle dabei? Dann bewirb dich initiativ für unseren Talentpool.", null],
  ["Gerne berücksichtigen wir deine Bewerbung auch für zukünftige Stellen.", null],
  ["Wir suchen laufend nach Möglichkeiten, unsere Prozesse zu verbessern.", null],
  ["Wir stellen laufend ein.", "always_hiring"],
  ["Wir sind immer auf der Suche nach motivierten Menschen.", "always_hiring"],
  ["Es gibt keine konkrete Stelle, wir sammeln Bewerbungen für zukünftige Stellen.", "no_specific_opening"],
  ["Initiativbewerbung (m/w/d)", "open_application_title"],
  // third review round: EN
  ["We are building a talent pool for future roles.", "talent_pool"],
  ["We are building a talent pool.", "talent_pool"],
  ["We're growing our talent community for future openings.", "talent_pool"],
  ["This is an evergreen posting.", "evergreen_posting"],
  ["We accept applications on a rolling basis for upcoming positions.", "future_openings"],
  ["We collect applications for upcoming positions.", "future_openings"],
  ["We are continuously hiring engineers, so feel free to apply at any time.", "always_hiring"],
  ["This posting is for our talent pool, not for a specific team.", "talent_pool"],
  ["This role is for our talent pool for future roles.", "talent_pool"],
  ["We're always hiring, not only engineers but also designers.", "always_hiring"],
  ["This is not only a talent pool posting.", "talent_pool"],
  ["Why join us? We are always hiring.", "always_hiring"],
  ["We are hiring for future roles in Berlin.", "future_openings"],
  ["Evergreen job listings are a core feature of our ATS.", null],
  ["Our platform's talent pool module is used by 500 companies.", null],
  ["Our recruiting software helps employers manage evergreen requisitions.", null],
  ["Always hiring? Acme automates your sourcing.", null],
  ["Is this a talent pool posting?", null],
  ["Benefits\n- Mentoring for future roles in leadership", null],
  ["Benefits\n- Career development for future roles", null],
  ["Experience building a talent pipeline for engineering roles.", null],
  ["You will build and nurture our talent pipeline.", null],
  ["Build our talent pool for future growth.", null],
  ["Help us grow our talent community across Europe.", null],
  ["You will source candidates for upcoming roles.", null],
  ["We are not, as you may assume, building a talent pool.", null],
  // third review round: DE
  ["Wir suchen laufend Verstärkung.", "always_hiring"],
  ["Wir suchen laufend Verstärkung.\nKeine Agentur-Anfragen bitte.", "always_hiring"],
  ["Initiativbewerbung", "open_application_title"],
  ["Initiativbewerbung – Softwareentwickler", "open_application_title"],
  ["Initiativbewerbung für Entwickler (m/w/d)", "open_application_title"],
  ["Dies ist eine Initiativbewerbung.", "open_application"],
  ["Wir sammeln Bewerbungen für zukünftige Vakanzen.", "future_openings"],
  ["Wir stellen kontinuierlich Mitarbeiter ein.", "always_hiring"],
  ["Für unseren Talentpool suchen wir Entwickler, die keine Angst vor neuen Technologien haben.", "talent_pool"],
  ["Wir suchen laufend Verstärkung, nicht nur in Berlin, sondern auch in München.", "always_hiring"],
  ["Wir suchen laufend Verstärkung, die nicht nur programmiert, sondern mitdenkt.", "always_hiring"],
  ["Wir stellen laufend neue Kolleg:innen ein, die nicht lange fackeln.", "always_hiring"],
  ["Wir sind nicht nur immer auf der Suche nach Talenten.", "always_hiring"],
  ["Wir suchen für unseren Talentpool Softwareentwickler für unsere Standorte.", "talent_pool"],
  ["Für unseren Talentpool suchen wir Lösungsarchitekten für SAP.", "talent_pool"],
  ["Für unseren Talentpool suchen wir Entwickler für unsere Software für Logistik.", "talent_pool"],
  ["Wir suchen für unseren Talentpool Entwickler.", "talent_pool"],
  ["Diese Stelle ist für unseren Talentpool, nicht für eine konkrete Vakanz.", "no_specific_opening"],
  ["Was wir bieten\n- Gezielte Weiterbildung für zukünftige Positionen im Konzern", null],
  ["Unsere Software hilft Personalabteilungen beim Aufbau eines Talentpools.", null],
  ["Auf unserem Marktplatz stellen Händler laufend neue Angebote ein.", null],
  ["Unser Vertriebsteam sucht ständig nach neuen Kunden, und du hilfst dabei.", null],
  ["Wir suchen ständig nach neuen Kunden für unsere Software.", null],
  ["Für unseren Talentpool ist diese Anzeige, wie du dir denken kannst, nicht gedacht.", null],
  ["Diese Ausschreibung dient, wie du siehst, nicht dem Aufbau eines Talentpools.", null],
  ["Wir bauen eine Plattform für Talentpools.", null],
  ["Initiativbewerbung: Keine passende Stelle gefunden? Bewirb dich initiativ.", null],
  // talent pool with words in between, only with recruiting context in the sentence; "for our future …"
  ["By joining our AI talent pool, you will be contacted as a priority for our future opportunities in the following areas:", "talent_pool_join"],
  ["Join our engineering talent community to apply for future roles.", "talent_pool_join"],
  ["Apply now and join our growing tech talent network.", "talent_pool_join"],
  ["Send us your CV for our data talent pool.", "talent_pool_join"],
  ["Submit your CV to join our global talent pool.", "talent_pool"],
  ["We collect applications for our future openings.", "future_openings"],
  ["We hire on a rolling basis for our upcoming positions.", "future_openings"],
  ["Joining our AI talent pool is not a commitment; you can still apply to open roles.", null],
  ["Berlin offers access to the largest tech talent pool in Europe.", null],
  ["Tap into a diverse global talent pool.", null],
  ["Berlin is home to a deep engineering talent pool.", null],
  ["You will mentor juniors in our internal talent community.", null],
  ["Organize events for our engineering talent community.", null],
  ["We run workshops for our internal talent community.", null],
  ["Contribute to our engineering talent pipeline.", null],
  ["Contribute to our engineering talent pool.", null],
  ["Organize events for our engineering talent community and source candidates for open roles.", null],
  ["We host meetups for our local talent community; candidates of all levels are welcome.", null],
  ["Join our team and grow with our engineering talent community.", null],
  ["Join our engineering talent community.", null],
  ["You will source candidates for our upcoming roles.", null],
  ["You'll recruit engineers for our future openings.", null],
  ["You will source candidates for our engineering talent pool.", null],
  ["Source candidates for our engineering talent pool and run interviews.", null],
  ["Mentoring for our future roles in leadership.", null],
  ["Training for our upcoming positions.", null],
  ["Career development for our future roles", null],
  // a recruiter's own duties for the talent pool are the role, not the posting
  ["As a recruiter, you will screen applicants for our engineering talent pool.", null],
  ["You'll recruit candidates for our tech talent community.", null],
  ["Identify and attract candidates for our engineering talent pool.", null],
  ["In this role you will interview candidates for our AI talent network.", null],
  ["Your job: build relationships with candidates for our tech talent pool.", null],
  ["- Sourcing and assessing candidates for our data talent pool", null],
  ["You will evaluate and place applicants into our engineering talent network.", null],
  // … also on the line under a short heading (the segmenter reads them together)
  ["Your tasks\nScreen applicants for our engineering talent pool and run interviews.", null],
  ["About the role\nIdentify and attract candidates for our engineering talent pool.", null],
  ["About the role\nGrow and nurture our talent pool for future roles.", null],
  // … and after bullets the segmenter does not take for list markers ("▪", "a)", "✓"), under a heading or an intro sentence
  ["Your tasks:\n▪ Screen applicants for our engineering talent pool\n▪ Run interviews", null],
  ["What you'll do\na) Screen applicants for our engineering talent pool\nb) Run interviews", null],
  ["As our recruiter you will:\n✓ Build relationships with candidates for our tech talent pool", null],
  ["Acme builds payroll software.\n▪ Screen applicants for our engineering talent pool\n▪ Run interviews", null],
  ["Acme builds payroll software.\na) Screen applicants for our engineering talent pool\nb) Run interviews", null],
  ["Acme builds payroll software.\n✓ Build relationships with candidates for our tech talent pool", null],
  ["Acme builds payroll software.\n➤ Grow and nurture our talent pool for future roles.", null],
  ["Acme builds payroll software.\n1. Screen applicants for our engineering talent pool\n2. Run interviews", null],
  ["Acme builds payroll software.\r\n▪ Screen applicants for our engineering talent pool\r\n▪ Run interviews", null],
  ["Your tasks:\r\n1) Identify and attract candidates for our engineering talent pool", null],
  // a bullet before the posting's own words changes nothing
  ["Acme builds payroll software.\n▪ We are hiring for our AI talent pool – apply now.", "talent_pool_join"],
  ["Acme builds payroll software.\n✓ Interviewing now for our AI talent pool — apply today.", "talent_pool_join"],
  // … but the posting's own words with the same verbs still count
  // a noun or title at the start of the sentence is no duty (no object of the verb)
  ["Interviewing now for our AI talent pool — apply today.", "talent_pool_join"],
  ["Placements into our AI talent pool happen on a rolling basis; apply now.", "talent_pool_join"],
  ["Support engineers wanted for our talent pool – apply now.", "talent_pool"],
  ["Help us grow by joining our engineering talent pool for future roles.", "talent_pool_join"],
  ["If selected, you will be placed into our AI talent pool and contacted for future roles.", "talent_pool_join"],
  ["We are hiring for our AI talent pool – apply now.", "talent_pool_join"],
  ["We are recruiting for our talent pool.", "talent_pool"],
  ["Hiring for our AI talent pool: apply now.", "talent_pool_join"],
  ["Recruiting engineers for our data talent pool – send your CV.", "talent_pool_join"],
  ["Find out how to apply for our AI talent pool and future roles.", "talent_pool_join"],
  // events for a community, the event word before or after it; "opportunities" only with a job word
  ["This program is for our talent pool: apply now for future roles.", "talent_pool"],
  ["This session is for our AI talent pool: candidates apply below.", "talent_pool_join"],
  ["Join our engineering talent community for networking opportunities and events.", null],
  ["Join our AI talent community meetups to meet our hiring team.", null],
  ["Join our tech talent network for mentoring opportunities.", null],
  ["Join our data talent community for learning opportunities.", null],
  ["Join our engineering talent pool for new opportunities.", "talent_pool_join"],
  ["Join our AI talent pool for career opportunities.", "talent_pool_join"],
  // a list under a duties heading that the segmenter does not see as one ("?" heading, emoji, "&amp;", blank line)
  ["What awaits you?\n- Coordinate interviews for upcoming positions.", null],
  ["What will I be doing?\n\n- Run interviews.\n- Coordinate interviews for upcoming positions.", null],
  ["🛠️ About the role:\n- Coordinate interviews for upcoming positions.", null],
  ["THE ROLE &amp; THE TEAM\n- Coordinate interviews for upcoming positions.", null],
  ["Welche Aufgaben erwarten dich?\n- Aufbau unseres Talentpools für zukünftige Stellen", null],
  // … but not under a question or heading that is not about the duties
  ["Ready to join us?\n- We are always hiring.", "always_hiring"],
  ["Why join us?\n- We are always hiring great people.", "always_hiring"],
  ["Ready to take on new responsibilities?\n- We collect applications for upcoming positions.", "future_openings"],
  ["Bereit für mehr?\n- Wir stellen laufend ein.", "always_hiring"],
  ["Warum wir?\n- Wir suchen ständig neue Kolleginnen und Kollegen.", "always_hiring"],
  // training for later roles is a benefit, technical development is the work: benefit lines stay out, hiring lines count
  ["Development opportunities for future roles.", null],
  ["Benefits\n- Professional development for future roles", null],
  ["Leadership development for our upcoming positions.", null],
  ["We collect applications in software development for future openings.", "future_openings"],
  ["We collect applications in software  development for future openings.", "future_openings"],
  ["We collect applications in software-development for future openings.", "future_openings"],
  ["We hire in backend development for upcoming positions.", "future_openings"],
  ["Gezielte Entwicklungsmöglichkeiten für zukünftige Positionen.", null],
  ["Was wir bieten\n- Karriereentwicklung für zukünftige Positionen", null],
  ["Persönliche Weiterentwicklung für künftige Stellen im Konzern.", null],
  ["Für unsere Softwareentwicklung sammeln wir Bewerbungen für zukünftige Stellen.", "future_openings"],
  ["Wir suchen Talente in der Produktentwicklung für zukünftige Positionen.", "future_openings"],
  // a statement with a short invitation tagged on is no question; a question with a tag stays one
  ["We are always hiring – want to join?", "always_hiring"],
  ["We're always hiring - interested?", "always_hiring"],
  ["We are always hiring; want to join us?", "always_hiring"],
  ["So, we are always hiring – are you in?", "always_hiring"],
  ["Wir suchen laufend Verstärkung – bist du dabei?", "always_hiring"],
  ["Wir stellen laufend ein – Lust?", "always_hiring"],
  ["Wir suchen ständig neue Kolleginnen und Kollegen – hast du Lust?", "always_hiring"],
  ["Always hiring – sound familiar?", null],
  ["So, are you always hiring – or just pretending?", null],
  ["Stellt ihr laufend ein – und findet niemanden?", null],
  ["Are you looking for a team that is always hiring – and growing?", null],
  ["Is your company always hiring – and struggling to cope?", null],
  ["Is this a talent pool posting; or a real vacancy?", null],
  ["Is your company always hiring and you can't keep up?", null],
  ["Is your team always hiring – interested?", null],
  ["So, are you always hiring – want to join?", null],
  ["We build sourcing software – always hiring?", null],
  ["Suchen Sie ständig neue Mitarbeiter – interessiert?", null],
  ["Stellen Sie laufend neue Leute ein – Interesse an unserer Software?", null],
  // "Initiativbewerbung" as a line of its own: the posting's title above the duties, a footer below them
  ["Initiativbewerbung – Softwareentwicklung\nWir freuen uns über deine Initiativbewerbung als Entwickler:in in Berlin.", "open_application_title"],
  ["Initiativbewerbungen", "open_application_title"],
  ["Initiativbewerbung – Softwareentwicklung\nDeine Aufgaben:\n- Backend-Services entwickeln\n- Code Reviews\n\nInitiativbewerbung\nWir freuen uns über deine Initiativbewerbung.", "open_application_title"],
  ["Deine Aufgaben:\n- Code Reviews\n\nInitiativbewerbung (m/w/d)", "open_application_title"],
  ["Deine Aufgaben:\n- Entwicklung von Backend-Services\n- Code Reviews\n\nInitiativbewerbungen:\nWir freuen uns auch über Initiativbewerbungen für andere Bereiche.", null],
  ["Deine Aufgaben:\n- Code Reviews\n\nInitiativbewerbung\nWir freuen uns auch über deine Initiativbewerbung für andere Bereiche.", null],
  ["Your tasks:\n- Code reviews\n\nInitiativbewerbung – alle Bereiche\nWir freuen uns über deine Initiativbewerbung.", null],
  // a qualification ("experience building a talent pipeline") is about the candidate, up to the end of its clause
  ["Experience building a talent pipeline for future roles.", null],
  ["5+ years of experience in building talent pipelines for upcoming positions.", null],
  ["Proven track record of growing a talent community for future roles.", null],
  ["Track record in building a talent pool for future openings is a plus.", null],
  ["Experience building a talent pipeline is valued; we are always hiring.", "always_hiring"],
  ["You have experience building talent pools, and we are always hiring.", "always_hiring"],
  ["We are building a talent pipeline for future roles", "talent_pool"],
  ["Erfahrung im Aufbau eines Talentpools für zukünftige Stellen.", null],
  ["Mehrjährige Erfahrung beim Aufbau unseres Talentpools ist ein Plus.", null],
  ["Erfahrung im Aufbau eines Talentpools ist ein Plus, und wir stellen laufend ein.", "always_hiring"],
  ["Diese Ausschreibung dient dem Aufbau unseres Talentpools.", "talent_pool"],
  // the employer's SaaS product, not this posting; a SaaS team still hires
  ["Our SaaS lets agencies post evergreen job listings.", null],
  ["Our SaaS platform lets agencies post evergreen job listings.", null],
  ["Our SaaS team is always hiring.", "always_hiring"],
  ["We are a SaaS company and we are always hiring.", "always_hiring"],
  // German: a compound talent pool after "unseren" with recruiting words; a recruiter's own duties are the role
  ["Bewirb dich jetzt für unseren KI-Talentpool.", "talent_pool_join"],
  ["Sende uns deinen Lebenslauf für unseren Tech-Talentpool.", "talent_pool_join"],
  ["Für unseren KI-Talentpool suchen wir Entwickler – jetzt bewerben!", "talent_pool_join"],
  ["Organisiere Events für unseren KI-Talentpool.", null],
  ["Berlin bietet Zugang zu einem riesigen KI-Talentpool.", null],
  ["Als Recruiter sprichst du Kandidaten für unseren Talentpool an.", null],
  ["Du sprichst Kandidaten für unseren KI-Talentpool an und führst Interviews.", null],
  ["Du identifizierst und gewinnst Talente für unseren Talentpool.", null],
  ["Deine Aufgabe: Kandidaten für unseren Talentpool gewinnen.", null],
  ["- Ansprache von Kandidaten für unseren Talentpool", null],
  ["Identifikation und Ansprache von Bewerbern für unseren Talentpool.", null],
  ["Kandidaten für unseren Talentpool identifizieren und ansprechen", null],
  ["Über uns\n▪ Direktansprache von Entwicklern für unseren Tech-Talentpool", null],
  ["Entwickler für unseren Talentpool gesucht – jetzt bewerben!", "talent_pool"],
  ["Du bewirbst dich für unseren Talentpool und wir melden uns bei passenden Stellen.", "talent_pool"],
  ["Mit deiner Bewerbung für unseren Talentpool bist du bei zukünftigen Stellen dabei.", "talent_pool"],
  // a German duties heading in the du form
  ["Wie du bei uns etwas bewirken kannst\n- Aufbau unseres Talentpools für zukünftige Stellen", null],
  // a tagged statement: discourse markers before the wording, the tag is the whole text after the break
  ["So we are always hiring – want to join?", "always_hiring"],
  ["We grow fast and we are always hiring – want to join?", "always_hiring"],
  ["We are always hiring—want to join?", "always_hiring"],
  ["We grow fast, but are you always hiring – interested?", null],
  ["Your recruiters are always hiring – interested in a better ATS?", null],
  ["Always hiring – want to join our webinar on sourcing?", null],
  ["Wir stellen laufend ein – neugierig geworden?", "always_hiring"],
  // German events for a community, and a pool with "suchen wir"
  ["Organisiere Events für Kandidaten in unserem KI-Talentpool.", null],
  ["Wir veranstalten Workshops für unseren KI-Talentpool – Kandidaten willkommen.", null],
  ["Für unseren KI-Talentpool suchen wir Entwickler mit ML-Erfahrung.", "talent_pool_join"],  // an independent reviewer's adversarial set (EN + DE): footers and recruiter work, the company's own record, vocatives and
  // verbless questions before a tag, call-to-action tags, training versus technical development, qualification forms
  ["We hire in AI development for upcoming positions.", "future_openings"],
  ["We are recruiting across Research and Development for upcoming positions.", "future_openings"],
  ["We collect applications in iOS development for future openings.", "future_openings"],
  ["We collect applications in embedded development for future openings.", "future_openings"],
  ["We collect applications in ML development for future openings.", "future_openings"],
  ["We collect applications in business development for future openings.", "future_openings"],
  ["Personal and business development for future roles.", null],
  ["Our development team for upcoming projects is always hiring.", "always_hiring"],
  ["Wir suchen Verstärkung in der Entwicklung für zukünftige Positionen.", "future_openings"],
  ["Unser Entwicklungsteam wächst für kommende Projekte, wir stellen laufend ein.", "always_hiring"],
  ["Wir sammeln Bewerbungen im Bereich Entwicklung für zukünftige Stellen.", "future_openings"],
  ["Constantly hiring – sound like you?", null],
  ["Always recruiting – is that you?", null],
  ["Recruiters, are you always hiring – interested?", null],
  ["Hey, is your team always hiring – curious?", null],
  ["Honestly, is your startup constantly recruiting – interested?", null],
  ["Hand aufs Herz: Sucht ihr ständig nach Entwicklern – interessiert?", null],
  ["Liebe HR-Teams, stellt ihr laufend ein – neugierig?", null],
  ["When we grow, we are always hiring – want to join?", "always_hiring"],
  ["How we work: we are always hiring – want to join?", "always_hiring"],
  ["We are always hiring – interested in joining?", "always_hiring"],
  ["Wir stellen laufend ein – Interesse geweckt?", "always_hiring"],
  ["Wir stellen laufend ein – klingt spannend?", "always_hiring"],
  ["Wie immer suchen wir laufend Verstärkung – bist du dabei?", "always_hiring"],
  ["Our clients are always hiring – interested?", "always_hiring"],
  ["With our history of growing fast, we are always hiring.", "always_hiring"],
  ["Given our track record of growing quickly, we're always hiring.", "always_hiring"],
  ["Thanks to our experience in building great teams, we are constantly recruiting.", "always_hiring"],
  ["You get the ability to grow in a team that is always hiring.", "always_hiring"],
  ["Mit unserer Erfahrung in der Entwicklung von KI-Produkten stellen wir laufend ein.", "always_hiring"],
  ["Dank unserer Expertise im Aufbau von Teams suchen wir ständig neue Kolleginnen.", "always_hiring"],
  ["Experience building data pipelines, and we are always hiring.", "always_hiring"],
  ["Experience building a talent pipeline (we are always hiring).", "always_hiring"],
  ["Experience in managing teams – we are always hiring.", "always_hiring"],
  ["Strong skills managing a talent pool for future roles.", null],
  ["Hands-on experience scaling a talent pipeline for future roles.", null],
  ["Experience with talent pipelines for future roles.", null],
  ["Erfahrung in der Pflege eines Talentpools für zukünftige Stellen.", null],
  ["Erfahrung mit dem Aufbau eines Talentpools für zukünftige Stellen.", null],
  ["Gerne nehmen wir deine Bewerbung auch in unseren Talentpool auf.", null],
  ["Mit deiner Bewerbung nehmen wir dich gerne in unseren Talentpool auf.", null],
  ["Wir suchen eine Recruiterin, die Kandidaten in unserem Talentpool betreut.", null],
  ["Sie sind Ansprechpartner für alle Bewerber in unserem Talentpool.", null],
  ["Wir suchen Mentorinnen für unser Talent-Netzwerk.", null],
  ["Bewirb dich jetzt für unseren KI-Talentpool!", "talent_pool_join"],
  ["Bewirb dich für unseren Talentpool für Data Science.", "talent_pool"],
  ["Für unseren Talentpool im Bereich KI freuen wir uns über deine Bewerbung.", "talent_pool"],
  ["Wir suchen dich für unseren KI-Talentpool.", "talent_pool_join"],
  ["Wir suchen dich für unsere KI-Talent-Community.", "talent_pool_join"],
  ["Deine Bewerbung für unseren KI-Talentpool-Prozess.", null],
  ["Kandidat:innen für unseren Talentpool gesucht – bewirb dich!", "talent_pool"],
  ["Initiativbewerbung\nWir freuen uns über deine Bewerbung.\n\nDeine Aufgaben\n- Entwicklung\n\nInitiativbewerbung\nJetzt bewerben.", "open_application_title"],
  ["Über uns\nWir bauen Software.\nDeine Aufgaben\n- Code\nInitiativbewerbung (m/w/d) für alle Bereiche möglich.", "open_application_title"],
  ["Hand aufs Herz: Stellen Sie laufend ein – interessiert?", null],
  ["Liebe Recruiter, stellen Sie laufend ein – neugierig?", null],
  ["Berufserfahrung im Aufbau eines Talentpools für zukünftige Stellen.", null],
  ["Praxiserfahrung im Aufbau eines Talentpools für zukünftige Stellen.", null],
  ["Wir nehmen deine Bewerbung gerne in unseren Talentpool auf, sofern du zustimmst.", null],
  ["Gerne nehmen wir dich in unseren Talentpool auf.", null],
  ["Bewerbungen nehmen wir gerne in unseren Talentpool auf.", null],
  ["Always hiring – interested?", null],
  ["We are always hiring – want to join? Apply below.", "always_hiring"],
  ["Do you know that we are always hiring – interested?", null],
  ["Did you know we are always hiring – curious?", null],
  ["Are we always hiring? Yes – want to join?", null],
  ["Wir suchen ständig neue Kolleginnen und Kollegen; Interesse?", "always_hiring"],
  ["Personal development for future roles.", null],
  ["Business development opportunities for future roles.", null],
  ["Leadership and business development for future roles.", null],
  ["Join our talent pool – interested?", null],
  ["Join our team – we are always hiring – want to join?", "always_hiring"],
  ["Werden Sie Teil unseres Teams, wir stellen laufend ein – interessiert?", "always_hiring"],
  ["Have a look: we are always hiring – interested?", "always_hiring"],
  ["Kennen Sie das? Wir stellen laufend ein – interessiert?", "always_hiring"],
  ["Experience in building a talent pool for future roles; we are always hiring.", "always_hiring"],
  ["Erfahrung im Aufbau von Talentpools für zukünftige Stellen, und wir stellen laufend ein.", "always_hiring"],
  ["Your experience managing teams helps us, since we are always hiring.", "always_hiring"],
  ["We value experience building products and we are always hiring.", "always_hiring"],
  ["Background in growing companies? We are always hiring.", "always_hiring"],
  // a tagged statement needs the company as subject before the hit's end; a qualification ends only before "we" / "wir"; "your"
  // experience is the candidate's
  ["Tired of always hiring – interested?", null],
  ["Still always hiring – interested?", null],
  ["Sick of always hiring – interested?", null],
  ["Ever feel like your team is always hiring – curious?", null],
  ["Feel like you're always hiring – curious?", null],
  ["You're always hiring – curious?", null],
  ["Recruiters always hiring – interested?", null],
  ["Hiring managers, always hiring – interested?", null],
  ["Is your company, like ours, always hiring – interested?", null],
  ["Companies that trust us are always hiring – interested?", null],
  ["Recruiters who work with us are always hiring – curious?", null],
  ["Kunden von uns stellen laufend ein – interessiert?", null],
  ["At Acme we are always hiring – want to join?", "always_hiring"],
  ["Like many startups, we are always hiring – interested?", "always_hiring"],
  ["Did you know: we are always hiring – curious?", "always_hiring"],
  ["Honestly, we're always hiring – interested?", "always_hiring"],
  ["We're always hiring – are you in?", "always_hiring"],
  ["Our team is always hiring – want to join?", "always_hiring"],
  ["Bei uns suchen wir laufend Verstärkung – bist du dabei?", "always_hiring"],
  ["Bei Acme suchen wir ständig neue Kolleginnen – Lust?", "always_hiring"],
  ["Unser Team stellt laufend ein – interessiert?", "always_hiring"],
  ["Ständig auf der Suche nach Talenten – neugierig?", null],
  ["Kenntnisse im Aufbau von Bewerberpools bringst du für zukünftige Vakanzen mit.", null],
  ["Erfahrung im Aufbau eines Talentpools hast du idealerweise schon für künftige Stellen gesammelt.", null],
  ["Experience building talent pools, so you can staff future roles.", null],
  ["Experience building talent pools, we are always hiring.", "always_hiring"],
  ["Your experience building talent pipelines for future roles is a strong plus.", null],
  ["Your background in building talent pools for upcoming positions matters.", null],
  // known limits, by design: an exclude_context line takes out the whole sentence; a clause that opens with the hit has no
  // subject; German talent_pool_join reads only "für unseren …"
  ["Bewirb dich für unseren KI-Talentpool und erhalte Einladungen zu Events für unsere Talent-Community.", null],
  ["Join our AI talent pool – want to apply?", null],
  ["Mit deiner Bewerbung gewinnst du Zugang zu unserem KI-Talentnetzwerk und zu zukünftigen Stellen.", null],
];

describe("evergreen_wording against the fixture packs", () => {
  const rules = fixtureRules();
  const unfiltered = { ...rules, prefilter: null };

  it.each(CASES)("%j → %s", (sentence, expected) => {
    const found = evergreenWording(sentence, rules);
    expect(found?.patternId ?? null).toBe(expected);
    // the prefilter only makes it faster: the same verdict without it
    expect(evergreenWording(sentence, unfiltered)?.patternId ?? null).toBe(expected);
    // C7: the quote is the description at its offset
    if (found) expect(sentence.slice(found.offset, found.offset + found.quote.length)).toBe(found.quote);
  });

  it("every evergreen pattern passes the packs' prefilter", () => {
    expect(rules.prefilterViolations).toEqual([]);
  });

  it("quotes the sentence inside a longer JD at its offset", () => {
    const jd = "About us\nWe ship logistics software.\n\nWhat we offer\nGood pay. This posting is for our talent pool. Apply now.";
    const found = evergreenWording(jd, rules);
    expect(found).toMatchObject({ patternId: "talent_pool", quote: "This posting is for our talent pool." });
    expect(jd.slice(found?.offset, (found?.offset ?? 0) + (found?.quote.length ?? 0))).toBe(found?.quote);
  });

  it("the talent pool posting with words in between: exact quote, offset and pattern", () => {
    const sentence = "By joining our AI talent pool, you will be contacted as a priority for our future opportunities in the following areas:";
    const jd = `Are you passionate about AI? We build software for clinics.\n\nWe use AI across our products.\n\n${sentence}\n\nThe areas we are looking for:\n- ML engineering\n- NLP`;
    const found = evergreenWording(jd, rules);
    expect(found).toEqual({ code: "evergreen_wording", points: rules.settings.evergreen_wording.points, patternId: "talent_pool_join", quote: sentence, offset: jd.indexOf(sentence) });
    // each of the two widened patterns finds it on its own
    const only = (id: string) => ({ ...rules, evergreen: rules.evergreen.filter((pattern) => pattern.id === id) });
    expect(evergreenWording(jd, only("talent_pool_join"))).toMatchObject({ patternId: "talent_pool_join", quote: sentence, offset: jd.indexOf(sentence) });
    expect(evergreenWording(jd, only("future_openings"))).toMatchObject({ patternId: "future_openings", quote: sentence, offset: jd.indexOf(sentence) });
    // and neither did before: the original talent_pool phrase does not take "AI" in between
    expect(evergreenWording(jd, only("talent_pool"))).toBeNull();
  });

  it("skips hits the caller hides (AI trap ranges)", () => {
    const jd = "This posting is for our talent pool.";
    expect(evergreenWording(jd, rules, { skip: () => true })).toBeNull();
  });
});

describe("evergreen_wording reads its words and limits from the config", () => {
  const pack = { evergreen_patterns: [{ id: "pool", pattern: "talent pool", check_negation: true }], negation_cues: ["not"], prefilter: ["talent"] };

  it("a negation cue after the phrase within negation_words_after", () => {
    const near = rulesWith((s) => (s.negation_words_after = 5), pack);
    expect(evergreenWording("A talent pool it is not.", near)).toBeNull();
    const off = rulesWith((s) => (s.negation_words_after = 0), pack);
    expect(evergreenWording("A talent pool it is not.", off)?.patternId).toBe("pool");
  });

  it("negation_after: clause searches to the end of the clause, words only negation_words_after words", () => {
    const sentence = "Our talent pool is one we will here very clearly not use; it is a real role.";
    expect(evergreenWording(sentence, rulesWith((s) => (s.negation_words_after = 3), pack))?.patternId).toBe("pool");
    expect(evergreenWording(sentence, rulesWith((s) => (s.negation_words_after = 3), { ...pack, negation_after: "clause" }))).toBeNull();
    // an entry's own setting wins over its pack's; the clause ends at a clause break
    const entry = { ...pack, evergreen_patterns: [{ ...pack.evergreen_patterns[0]!, negation_after: "clause" as const }], clause_breaks: [";"] };
    expect(evergreenWording(sentence, rulesWith((s) => (s.negation_words_after = 3), entry))).toBeNull();
    expect(evergreenWording("Our talent pool; it is not a fake.", rulesWith(() => {}, entry))?.patternId).toBe("pool");
  });

  it("lead_in_question: the question marks, where the question starts and the line above come from the pack", () => {
    const footer = { ...pack, exclude_context: ["missing a role"] };
    const lead = (over: Partial<{ ends: string[]; starts: string[]; line_above: boolean }>) => ({ ...footer, lead_in_question: { ends: ["?"], starts: ["."], line_above: true, ...over } });
    expect(evergreenWording("Missing a role? Our talent pool.", rulesWith(() => {}, lead({})))).toBeNull();
    expect(evergreenWording("Missing a role? Our talent pool.", rulesWith(() => {}, lead({ ends: [] })))?.patternId).toBe("pool");
    // (a short line without end punctuation is a heading read with the next line: heading_max_chars 5 keeps them apart)
    const noHeadings = (s: { heading_max_chars: number }) => (s.heading_max_chars = 5);
    expect(evergreenWording("Missing a role？\nOur talent pool.", rulesWith(noHeadings, lead({})))?.patternId).toBe("pool");
    expect(evergreenWording("Missing a role？\nOur talent pool.", rulesWith(noHeadings, lead({ ends: ["?", "？"] })))).toBeNull();
    expect(evergreenWording("Missing a role?\nOur talent pool.", rulesWith(() => {}, lead({ line_above: false })))?.patternId).toBe("pool");
    expect(evergreenWording("Missing a role?\nOur talent pool.", rulesWith(() => {}, lead({})))).toBeNull();
    // the question starts after the last start mark: "Missing a role" is not in "Hi. Got one?"
    expect(evergreenWording("Missing a role. Got one? Our talent pool.", rulesWith(() => {}, lead({})))?.patternId).toBe("pool");
    // a sentence that is itself a question does not count; which marks end a question comes from the pack
    expect(evergreenWording("Our talent pool?", rulesWith(() => {}, lead({})))).toBeNull();
    expect(evergreenWording("Our talent pool?", rulesWith(() => {}, lead({ ends: [] })))?.patternId).toBe("pool");
  });

  it("requires_context: a hit counts only when its piece also matches one of the entry's patterns", () => {
    const entry = { id: "pool", pattern: "talent pool", check_negation: true };
    const plain = rulesWith(() => {}, { ...pack, evergreen_patterns: [entry] });
    const strict = rulesWith(() => {}, { ...pack, evergreen_patterns: [{ ...entry, requires_context: ["apply"] }] });
    expect(evergreenWording("Our talent pool.", plain)?.patternId).toBe("pool");
    expect(evergreenWording("Our talent pool.", strict)).toBeNull();
    expect(evergreenWording("Our talent pool. Apply now.", strict)).toBeNull();
    expect(evergreenWording("Apply to our talent pool.", strict)?.patternId).toBe("pool");
    expect(() => rulesWith(() => {}, { ...pack, evergreen_patterns: [{ ...entry, requires_context: ["(unclosed"] }] })).toThrow("ghost.evergreen_patterns[0].requires_context[0]");
  });

  it("question_tag: a statement with a short invitation after a break is read as a statement (words from the pack, length from pipeline.yaml)", () => {
    const tag = { breaks: ["\\s[–-]\\s", ";"], invitations: ["want\\s+to\\s+join(?:\\s+\\p{L}+)*", "interested"], openers: ["is", "are"], markers: ["so"], subjects: [] as string[] };
    const lead = { ends: ["?"], starts: ["."], line_above: true };
    const withTag = (edit: (s: { question_tag_max_words: number }) => void = () => {}, over: Partial<typeof tag> = {}) =>
      rulesWith(edit, { ...pack, lead_in_question: lead, question_tag: { ...tag, ...over } });
    expect(evergreenWording("Our talent pool – want to join?", withTag())?.patternId).toBe("pool");
    expect(evergreenWording("Our talent pool; interested?", withTag())?.patternId).toBe("pool");
    // no question tag configured: a question as before
    expect(evergreenWording("Our talent pool – want to join?", rulesWith(() => {}, { ...pack, lead_in_question: lead }))).toBeNull();
    // the tag must be an invitation as a whole, and be short enough
    expect(evergreenWording("Our talent pool – sound familiar?", withTag())).toBeNull();
    expect(evergreenWording("Our talent pool – interested in a better ATS?", withTag())).toBeNull();
    expect(evergreenWording("Our talent pool – and still want to join?", withTag())).toBeNull();
    expect(evergreenWording("Our talent pool – want to join the best team in town?", withTag((s) => (s.question_tag_max_words = 4)))).toBeNull();
    expect(evergreenWording("Our talent pool – want to join the best team in town?", withTag((s) => (s.question_tag_max_words = 10)))?.patternId).toBe("pool");
    // the break comes from the pack
    expect(evergreenWording("Our talent pool, want to join?", withTag())).toBeNull();
    expect(evergreenWording("Our talent pool, want to join?", withTag(() => {}, { breaks: [","] }))?.patternId).toBe("pool");
    // a clause that opens with a question word (after a discourse marker) stays a question
    expect(evergreenWording("Is it our talent pool – interested?", withTag())).toBeNull();
    expect(evergreenWording("So is it our talent pool – interested?", withTag())).toBeNull();
    expect(evergreenWording("So is it our talent pool – interested?", withTag(() => {}, { markers: [] }))?.patternId).toBe("pool");
    // a comma or colon starts the clause: what comes before it does not decide
    expect(evergreenWording("Recruiters, is it our talent pool – interested?", withTag())).toBeNull();
    expect(evergreenWording("Is it new: our talent pool – interested?", withTag())?.patternId).toBe("pool");
    // a clause that opens with the hit itself has no subject: a question
    expect(evergreenWording("Talent pool – interested?", withTag())).toBeNull();
    expect(evergreenWording("So, talent pool – interested?", withTag())).toBeNull();
    // openers and markers are phrases matched at the start of the clause, up to a word end
    expect(evergreenWording("Isabel runs our talent pool – interested?", withTag())?.patternId).toBe("pool");
    expect(evergreenWording("As always our talent pool – interested?", withTag(() => {}, { openers: ["as(?!\\s+always)"] }))?.patternId).toBe("pool");
    expect(evergreenWording("As usual our talent pool – interested?", withTag(() => {}, { openers: ["as(?!\\s+always)"] }))).toBeNull();
    expect(evergreenWording("As usual is it our talent pool – interested?", withTag(() => {}, { markers: ["as\\s+usual"] }))).toBeNull();
    expect(() => withTag(() => {}, { openers: ["(unclosed"] })).toThrow("ghost.question_tag.openers[0]");
    // a hit inside the tag is part of the question
    expect(evergreenWording("We build software – interested in our talent pool?", withTag())).toBeNull();
    // with subjects: the clause needs one of them before the hit's end, as a whole word
    const subjects = { subjects: ["we", "our", "wir"] };
    expect(evergreenWording("At Acme we run a talent pool – interested?", withTag(() => {}, subjects))?.patternId).toBe("pool");
    expect(evergreenWording("Tired of a talent pool – interested?", withTag(() => {}, subjects))).toBeNull();
    expect(evergreenWording("Tired of a talent pool – interested?", withTag())?.patternId).toBe("pool");
    expect(evergreenWording("Your talent pool – interested?", withTag(() => {}, subjects))).toBeNull();
    expect(evergreenWording("Wedding talent pool – interested?", withTag(() => {}, subjects))).toBeNull();
    // in the hit's own clause: a subject before a comma does not count
    expect(evergreenWording("We know, a talent pool – interested?", withTag(() => {}, subjects))).toBeNull();
    // in the hit counts too (German puts the subject after the verb)
    const german = rulesWith(() => {}, { ...pack, evergreen_patterns: [{ id: "search", pattern: "suchen (?:wir |sie )?laufend talente", check_negation: true }], prefilter: ["laufend"], lead_in_question: lead, question_tag: { ...tag, ...subjects, invitations: ["interessiert"] } });
    expect(evergreenWording("Bei Acme suchen wir laufend Talente – interessiert?", german)?.patternId).toBe("search");
    expect(evergreenWording("Bei Acme suchen Sie laufend Talente – interessiert?", german)).toBeNull();
    // the subjects are the company doing the hiring: an object pronoun ("us", "uns") is someone else's clause, so the packs do not
    // list it ("Companies that trust us are always hiring – interested?" is an ATS advert's question)
    const always = { id: "always", pattern: "always hiring", check_negation: true };
    const hiring = (words: string[]) => rulesWith(() => {}, { ...pack, evergreen_patterns: [always], prefilter: ["always"], lead_in_question: lead, question_tag: { ...tag, subjects: words } });
    expect(evergreenWording("Companies that trust us are always hiring – interested?", hiring(["we", "our"]))).toBeNull();
    expect(evergreenWording("Companies that trust us know we are always hiring – interested?", hiring(["we", "our"]))?.patternId).toBe("always");
    expect(evergreenWording("Companies that trust us are always hiring – interested?", hiring(["we", "our", "us"]))?.patternId).toBe("always");
    const germanSubjects = (words: string[]) =>
      rulesWith(() => {}, { ...pack, evergreen_patterns: [{ id: "search", pattern: "suchen (?:wir |sie )?laufend talente", check_negation: true }], prefilter: ["laufend"], lead_in_question: lead, question_tag: { ...tag, subjects: words, invitations: ["interessiert"] } });
    expect(evergreenWording("Kunden von uns suchen laufend Talente – interessiert?", germanSubjects(["wir", "unser\\p{L}*"]))).toBeNull();
    expect(evergreenWording("Bei uns suchen wir laufend Talente – interessiert?", germanSubjects(["wir", "unser\\p{L}*"]))?.patternId).toBe("search");
    expect(() => withTag(() => {}, { subjects: ["(unclosed"] })).toThrow("ghost.question_tag.subjects[0]");
  });

  it("exclude_clause: a match takes out the hits from its start to the end of its clause, not the whole sentence", () => {
    const always = { id: "always", pattern: "always hiring", check_negation: true };
    const both = { ...pack, evergreen_patterns: [...pack.evergreen_patterns, always], prefilter: ["talent", "always"], clause_breaks: [";"] };
    const clause = rulesWith(() => {}, { ...both, exclude_clause: ["experience building"] });
    expect(evergreenWording("Experience building a talent pool.", clause)).toBeNull();
    expect(evergreenWording("Experience building a talent pool; we are always hiring.", clause)?.patternId).toBe("always");
    // a hit before the match is not in its reach
    expect(evergreenWording("Our talent pool needs experience building.", clause)?.patternId).toBe("pool");
    // exclude_context takes out the whole sentence
    const sentence = rulesWith(() => {}, { ...both, exclude_context: ["experience building"] });
    expect(evergreenWording("Experience building a talent pool; we are always hiring.", sentence)).toBeNull();
    expect(() => rulesWith(() => {}, { ...both, exclude_clause: ["(unclosed"] })).toThrow("ghost.exclude_clause[0]");
  });

  it("exclude_clause_ends: where an exclude_clause range ends besides clause_breaks", () => {
    const always = { id: "always", pattern: "always hiring", check_negation: true };
    const both = { ...pack, evergreen_patterns: [...pack.evergreen_patterns, always], prefilter: ["talent", "always"], clause_breaks: [";"], exclude_clause: ["experience building"] };
    const text = "Experience building a talent pool is a plus, we are always hiring.";
    expect(evergreenWording(text, rulesWith(() => {}, both))).toBeNull();
    expect(evergreenWording(text, rulesWith(() => {}, { ...both, exclude_clause_ends: [",\\s*(?=we\\s)"] }))?.patternId).toBe("always");
    // the ends do not end a clause for anything else (exclude_context, the negation search)
    expect(evergreenWording("Experience building a talent pool, not hiring.", rulesWith(() => {}, { ...both, exclude_clause: [], exclude_clause_ends: [",\\s*"] }))).toBeNull();
    expect(() => rulesWith(() => {}, { ...both, exclude_clause_ends: ["(unclosed"] })).toThrow("ghost.exclude_clause_ends[0]");
  });

  it("only_before_duties: an entry's hit counts only above the first duties heading", () => {
    const title = { id: "title", pattern: "^talent pool(?=\\n|$)", check_negation: true };
    const duties = { responsibility_patterns: [{ id: "tasks", pattern: "^your tasks$" }] };
    const base = { ...pack, ...duties };
    const plain = rulesWith(() => {}, { ...base, evergreen_patterns: [title] });
    const scoped = rulesWith(() => {}, { ...base, evergreen_patterns: [{ ...title, only_before_duties: true }] });
    const footer = "Your tasks:\n- Code reviews\n\nTalent pool\nWe welcome all applications.";
    expect(evergreenWording(footer, plain)?.patternId).toBe("title");
    expect(evergreenWording(footer, scoped)).toBeNull();
    const posting = "Talent pool\nWe welcome all applications.\n\nYour tasks:\n- Code reviews\n\nTalent pool\nApply below.";
    expect(evergreenWording(posting, scoped)).toMatchObject({ patternId: "title", offset: 0 });
    // no duties heading at all: it counts
    expect(evergreenWording("About us\nWe build software.\n\nTalent pool\nWe welcome all applications.", scoped)?.patternId).toBe("title");
  });

  it("a negative list heading cancels its items", () => {
    const rules = rulesWith(() => {}, pack);
    expect(evergreenWording("This is not:\n- a talent pool\n- a fake role", rules)).toBeNull();
  });

  it("off, or zero points: no reason", () => {
    expect(evergreenWording("Our talent pool.", rulesWith((s) => (s.evergreen_wording.enabled = false), pack))).toBeNull();
    expect(evergreenWording("Our talent pool.", rulesWith((s) => (s.evergreen_wording.points = 0), pack))).toBeNull();
    expect(evergreenWording("Our talent pool.", rulesWith((s) => (s.evergreen_wording.points = 4), pack))?.points).toBe(4);
  });

  it("clips the quote to quote_max_chars, still verbatim", () => {
    const long = `${"Word ".repeat(120)}and this is our talent pool ${"word ".repeat(120)}end.`;
    const found = evergreenWording(long, rulesWith((s) => (s.quote_max_chars = 80), pack));
    expect(found?.quote.length).toBeLessThanOrEqual(80);
    expect(found?.quote).toContain("talent pool");
    expect(long.slice(found?.offset, (found?.offset ?? 0) + (found?.quote.length ?? 0))).toBe(found?.quote);
  });
});

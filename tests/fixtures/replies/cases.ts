import type { ReplyCategory } from "@/lib/replies/types";

/** Synthetic replies, none from a real mailbox. */
export interface ReplyCase {
  name: string;
  subject: string;
  body: string;
  expected: ReplyCategory;
}

export const REPLY_CASES: readonly ReplyCase[] = [
  { name: "en interview, body", subject: "Your application at Acme", body: "Hello, we would like to invite you to an interview for the role.", expected: "interview_invite" },
  { name: "en interview, subject", subject: "Interview invitation: Data Engineer", body: "Please see the details below.", expected: "interview_invite" },
  { name: "en: offer you an interview is an invite", subject: "Next steps", body: "We are pleased to offer you an interview next week.", expected: "interview_invite" },
  { name: "de interview, body", subject: "Ihre Bewerbung", body: "Wir laden Sie gerne zu einem Vorstellungsgespräch ein.", expected: "interview_invite" },
  { name: "de interview, subject", subject: "Einladung zum Vorstellungsgespräch", body: "Details folgen.", expected: "interview_invite" },
  { name: "en rejection", subject: "Your application", body: "Unfortunately we have decided to move forward with other candidates.", expected: "rejection" },
  { name: "en rejection, regret", subject: "Update on your application", body: "We regret to inform you that the position has been filled.", expected: "rejection" },
  { name: "de rejection", subject: "Ihre Bewerbung", body: "Leider müssen wir Ihnen mitteilen, dass wir Sie nicht berücksichtigen können.", expected: "rejection" },
  { name: "de rejection, subject", subject: "Absage zu Ihrer Bewerbung", body: "Vielen Dank für Ihr Interesse.", expected: "rejection" },
  { name: "en offer", subject: "Your offer letter", body: "We are delighted to extend you an offer of employment.", expected: "offer" },
  { name: "de offer", subject: "Ihr Vertragsangebot", body: "Anbei erhalten Sie unser Vertragsangebot für die Position.", expected: "offer" },
  { name: "en info request", subject: "Your application", body: "Could you please send us your salary expectations and your earliest start date?", expected: "info_request" },
  { name: "de info request", subject: "Ihre Bewerbung", body: "Bitte senden Sie uns noch Ihre Zeugnisse zu.", expected: "info_request" },
  { name: "en acknowledgement", subject: "Thank you for your application", body: "We have received your application and will review it.", expected: "acknowledgement" },
  { name: "de acknowledgement", subject: "Eingangsbestätigung", body: "Vielen Dank für Ihre Bewerbung. Wir haben Ihre Unterlagen erhalten.", expected: "acknowledgement" },
  { name: "out of office", subject: "Automatic reply: out of office", body: "I am out of the office until Monday.", expected: "other" },
  { name: "de out of office", subject: "Abwesenheitsnotiz", body: "Ich bin bis Montag nicht im Büro.", expected: "other" },
  { name: "marketing is no reply", subject: "Weekly newsletter", body: "We offer flexible plans for your team.", expected: "other" },
  // counter-examples: a word that looks decisive must not decide
  { name: "we offer flexible is no offer", subject: "About the team", body: "We offer flexible working hours at our office.", expected: "unclassified" },
  { name: "reschedule is no rejection", subject: "Your interview", body: "Unfortunately we need to reschedule your interview to Tuesday.", expected: "unclassified" },
  { name: "de: no date is no rejection", subject: "Ihr Gespräch", body: "Leider können wir den Termin am Montag nicht anbieten.", expected: "unclassified" },
  // a receipt that talks about its own limits is not a rejection: a wrong rejection proposes a terminal state
  { name: "receipt: cannot reply to each applicant", subject: "Thank you for your application", body: "Unfortunately we cannot reply to each applicant.", expected: "acknowledgement" },
  { name: "receipt: those not selected will be notified", subject: "Thank you for your application", body: "Candidates who are not selected will be notified.", expected: "acknowledgement" },
  { name: "receipt: if not selected", subject: "Application received", body: "If you are not selected we will let you know.", expected: "acknowledgement" },
  { name: "receipt: de, processing may take a while", subject: "Eingangsbestätigung", body: "Leider kann die Bearbeitung etwas dauern.", expected: "acknowledgement" },
  { name: "receipt: volume may take weeks", subject: "Application received", body: "Unfortunately, due to volume this may take 4 weeks.", expected: "acknowledgement" },
  { name: "no receipt subject, cannot reply: still no rejection", subject: "Your application", body: "Unfortunately we cannot reply to each applicant.", expected: "unclassified" },
  { name: "en rejection: decided not to move forward", subject: "Your application", body: "We have decided not to move forward with your application.", expected: "rejection" },
  { name: "en rejection: decided not to proceed", subject: "Your application", body: "After review we decided not to proceed.", expected: "rejection" },
  { name: "a real rejection opening with thanks stays one", subject: "Thank you for your application", body: "We have decided not to move forward with your application.", expected: "rejection" },
];

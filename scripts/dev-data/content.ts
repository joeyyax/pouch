/** Names, templates and provider wording the generated history draws from. */
import type { Random } from "./random";

export const FIRST_NAMES = [
  "ada", "alex", "amara", "ben", "caleb", "chen", "dana", "diego", "elena", "emeka", "farah", "grace",
  "hana", "ivan", "jamal", "jin", "kai", "lena", "liam", "maya", "mei", "nadia", "noah", "olu", "priya",
  "quinn", "rafael", "rosa", "sam", "sara", "tomas", "uma", "vera", "wes", "yara", "zoe", "iris", "owen",
  "ruth", "felix", "nora", "arjun", "lucia", "mateo", "ines", "theo", "june", "omar", "kira", "leo",
] as const;

export const LAST_NAMES = [
  "adeyemi", "alvarez", "baker", "brooks", "castillo", "cho", "dawson", "diaz", "ellis", "evans", "fischer",
  "garcia", "gupta", "hall", "hughes", "ito", "jensen", "kaur", "kim", "kowalski", "lee", "lopez", "martin",
  "moreau", "nakamura", "nguyen", "novak", "okafor", "olsen", "park", "patel", "quinn", "reyes", "rossi",
  "santos", "schmidt", "silva", "singh", "tanaka", "torres", "walsh", "wong", "young", "zhang", "haddad",
] as const;

/** Where recipients keep their mail, weighted roughly like a consumer SaaS list. */
export const MAILBOX_DOMAINS: readonly (readonly [string, number])[] = [
  ["gmail.com", 38],
  ["outlook.com", 9],
  ["icloud.com", 8],
  ["yahoo.com", 7],
  ["hotmail.com", 3],
  ["proton.me", 2],
  ["fastmail.com", 1],
  ["blueharbor.co", 4],
  ["riverstone.health", 3],
  ["widgetworks.com", 3],
  ["northgate.io", 3],
  ["lumen.studio", 3],
  ["kestrel.dev", 3],
  ["alderpoint.org", 2],
  ["tidewater.edu", 3],
  ["copperline.io", 2],
  ["marlowe.law", 2],
  ["pinecrest.coop", 2],
  ["saltbox.design", 2],
];

export interface Body {
  html: string | null;
  text: string | null;
}

export interface Template {
  /** Shared-body key. One object per template holds the body for every row not given its own. */
  key: string;
  weight: number;
  from: string;
  fromName: string;
  tags: string[];
  layout?: boolean;
  attachment?: { filename: string; contentType: string; kilobytes: number };
  subject: (random: Random) => string;
  body: (name: string) => Body;
}

const link = (href: string, label: string) => `<a href="${href}" style="color:#1d46f5">${label}</a>`;
const para = (text: string) => `<p style="margin:0 0 12px">${text}</p>`;
const heading = (text: string) => `<h1 style="font:600 20px system-ui;margin:0 0 12px">${text}</h1>`;

const WORKSPACES = ["Blue Harbor", "Riverstone", "Widgetworks", "Lumen", "Kestrel", "Alderpoint", "Copperline", "Saltbox"];
const PROJECTS = ["Q4 roadmap", "Website refresh", "Onboarding v2", "Billing migration", "Mobile beta", "Brand audit"];
const NOTEBOOKS = ["Trail log", "Garden plan", "Reading list", "Recipes", "Field sketches", "Bird counts"];

export const SCOPE_TEMPLATES: Template[] = [
  {
    key: "scope-sign-in",
    weight: 34,
    from: "hi@scope.example",
    fromName: "Scope",
    tags: ["auth"],
    subject: () => "Sign in to Scope",
    body: (name) => ({
      html: `${heading("Your sign-in link")}${para(`Hi ${name}, use this link to sign in. It works once and expires in 15 minutes.`)}${para(link("https://scope.example/auth/verify", "Sign in to Scope"))}`,
      text: `Hi ${name}, use this link to sign in. It works once and expires in 15 minutes.\n\nhttps://scope.example/auth/verify`,
    }),
  },
  {
    key: "scope-mention",
    weight: 22,
    from: "notifications@scope.example",
    fromName: "Scope",
    tags: ["notification"],
    subject: (random) => `${capitalize(random.pick(["dana", "chen", "priya", "tomas", "maya"]))} mentioned you in ${random.pick(PROJECTS)}`,
    body: (name) => ({
      html: `${para(`Hi ${name}, you were mentioned in a comment.`)}${para("“Can you take a look at the timeline before Friday?”")}${para(link("https://scope.example/inbox", "Open in Scope"))}`,
      text: `Hi ${name}, you were mentioned in a comment.\n\n“Can you take a look at the timeline before Friday?”\n\nOpen in Scope → https://scope.example/inbox`,
    }),
  },
  {
    key: "scope-invite",
    weight: 12,
    from: "hi@scope.example",
    fromName: "Scope",
    tags: ["invite"],
    layout: true,
    subject: () => "Your Scope invite",
    body: (name) => ({
      html: `${heading("You're invited to Scope")}${para(`Hi ${name}, a teammate added you to their Scope workspace. Your invite is good for seven days.`)}${para(link("https://scope.example/invite", "Open Scope"))}`,
      text: `Hi ${name}, a teammate added you to their Scope workspace. Your invite is good for seven days.\n\nOpen Scope → https://scope.example/invite`,
    }),
  },
  {
    key: "scope-digest",
    weight: 14,
    from: "hi@scope.example",
    fromName: "Scope",
    tags: ["digest"],
    layout: true,
    subject: (random) => `${random.pick(WORKSPACES)}, your weekly digest`,
    body: () => ({
      html: `${heading("Your week in Scope")}${para("4 deploys, 2 incidents, 1 open review.")}${para(link("https://scope.example/digest", "Read the full digest"))}`,
      text: "4 deploys, 2 incidents, 1 open review.\n\nRead the full digest → https://scope.example/digest",
    }),
  },
  {
    key: "scope-reset",
    weight: 8,
    from: "hi@scope.example",
    fromName: "Scope",
    tags: ["auth"],
    subject: () => "Reset your Scope password",
    body: (name) => ({
      html: `${para(`Hi ${name}, someone asked to reset your password. If it was you, ${link("https://scope.example/reset", "choose a new one")}.`)}${para("The link is good for one hour.")}`,
      text: `Hi ${name}, someone asked to reset your password. If it was you, choose a new one:\n\nhttps://scope.example/reset\n\nThe link is good for one hour.`,
    }),
  },
  {
    key: "scope-report",
    weight: 6,
    from: "reports@scope.example",
    fromName: "Scope",
    tags: ["report"],
    subject: (random) => `Your ${random.pick(WORKSPACES)} report is ready`,
    body: () => ({
      html: `${para("Your report is ready.")}${para(link("https://scope.example/reports", "Open it"))}`,
      text: "Your report is ready.\n\nOpen it → https://scope.example/reports",
    }),
  },
  {
    key: "scope-receipt",
    weight: 4,
    from: "billing@scope.example",
    fromName: "Scope billing",
    tags: ["billing"],
    attachment: { filename: "receipt.pdf", contentType: "application/pdf", kilobytes: 38 },
    subject: (random) => `Receipt for invoice ${random.int(3000, 9999)}`,
    body: () => ({
      html: `${para("Thanks — your payment went through. The receipt is attached.")}`,
      text: "Thanks — your payment went through. The receipt is attached.",
    }),
  },
];

export const SCOPE_TEST_TEMPLATES: Template[] = [
  {
    key: "scope-staging",
    weight: 1,
    from: "hi@scope.example",
    fromName: "Scope (staging)",
    tags: ["staging"],
    subject: (random) => random.pick(["Sign in to Scope (staging)", "Invite (staging)", "Digest preview (staging)"]),
    body: () => ({ html: "<p>Staging build 2026.09 — test send.</p>", text: "Staging build 2026.09 — test send." }),
  },
];

export const CEDARVINE_TEMPLATES: Template[] = [
  {
    key: "cedarvine-order",
    weight: 38,
    from: "orders@cedarvine.dev",
    fromName: "Cedarvine",
    tags: ["order"],
    subject: (random) => `Order #${random.int(10400, 19999)} confirmed`,
    body: (name) => ({
      html: `${heading("Thanks for your order")}${para(`Hi ${name}, we've got it and we're packing it now. We'll email again when it ships.`)}`,
      text: `Hi ${name}, we've got it and we're packing it now. We'll email again when it ships.`,
    }),
  },
  {
    key: "cedarvine-shipped",
    weight: 30,
    from: "orders@cedarvine.dev",
    fromName: "Cedarvine",
    tags: ["shipping"],
    subject: () => "Your order has shipped",
    body: (name) => ({
      html: `${para(`Good news, ${name} — your order is on its way.`)}${para(link("https://cedarvine.dev/track", "Track the package"))}`,
      text: `Good news, ${name} — your order is on its way.\n\nTrack the package → https://cedarvine.dev/track`,
    }),
  },
  {
    key: "cedarvine-reset",
    weight: 14,
    from: "hello@cedarvine.dev",
    fromName: "Cedarvine",
    tags: ["auth"],
    subject: () => "Password reset",
    body: () => ({
      html: `${para(`Reset your password → ${link("https://cedarvine.dev/reset", "cedarvine.dev/reset")}`)}${para("The link is good for one hour.")}`,
      text: "Reset your password → https://cedarvine.dev/reset\n\nThe link is good for one hour.",
    }),
  },
  {
    key: "cedarvine-invoice",
    weight: 8,
    from: "billing@cedarvine.dev",
    fromName: "Cedarvine billing",
    tags: ["billing"],
    attachment: { filename: "invoice.pdf", contentType: "application/pdf", kilobytes: 84 },
    subject: (random) => `Invoice ${random.int(2000, 2999)}`,
    body: () => ({
      html: "<p>Your invoice is attached.</p><p>Reply to this message with any questions.</p>",
      text: "Your invoice is attached.\n\nReply to this message with any questions.",
    }),
  },
  {
    key: "cedarvine-restock",
    weight: 10,
    from: "hello@cedarvine.dev",
    fromName: "Cedarvine",
    tags: ["restock"],
    subject: () => "It's back in stock",
    // Text only: sent from the stock system's plain template.
    body: (name) => ({
      html: null,
      text: `Hi ${name},\n\nThe item you asked about is back in stock. We'll hold it for 48 hours.\n\nhttps://cedarvine.dev/saved`,
    }),
  },
];

export const FIELDNOTES_TEMPLATES: Template[] = [
  {
    key: "fieldnotes-verify",
    weight: 40,
    from: "hello@fieldnotes.app",
    fromName: "Fieldnotes",
    tags: ["auth"],
    subject: () => "Verify your email",
    body: (name) => ({
      html: `${heading("One more step")}${para(`Hi ${name}, confirm this address to finish setting up Fieldnotes.`)}${para(link("https://fieldnotes.app/verify", "Verify email"))}`,
      text: `Hi ${name}, confirm this address to finish setting up Fieldnotes.\n\nhttps://fieldnotes.app/verify`,
    }),
  },
  {
    key: "fieldnotes-shared",
    weight: 35,
    from: "hello@fieldnotes.app",
    fromName: "Fieldnotes",
    tags: ["notification"],
    subject: (random) => `Shared notebook: ${random.pick(NOTEBOOKS)}`,
    body: (name) => ({
      html: `${para(`Hi ${name}, a notebook was shared with you.`)}${para(link("https://fieldnotes.app/shared", "Open notebook"))}`,
      text: `Hi ${name}, a notebook was shared with you.\n\nOpen notebook → https://fieldnotes.app/shared`,
    }),
  },
  {
    key: "fieldnotes-export",
    weight: 25,
    from: "hello@fieldnotes.app",
    fromName: "Fieldnotes",
    tags: ["export"],
    subject: () => "Your export is ready",
    // HTML only: the export mailer never shipped a text part.
    body: () => ({
      html: `${heading("Your export is ready")}${para(`${link("https://fieldnotes.app/exports", "Download it")} within seven days.`)}`,
      text: null,
    }),
  },
];

export const HARBORLINE_TEMPLATES: Template[] = [
  {
    key: "harborline-booking",
    weight: 60,
    from: "reservations@harborline.co",
    fromName: "Harborline Marina",
    tags: ["booking"],
    subject: () => "Your slip reservation is confirmed",
    body: (name) => ({
      html: `${para(`Hi ${name}, your slip is booked. Check-in opens at 2 pm at the harbor office.`)}`,
      text: `Hi ${name}, your slip is booked. Check-in opens at 2 pm at the harbor office.`,
    }),
  },
  {
    key: "harborline-reminder",
    weight: 40,
    from: "reservations@harborline.co",
    fromName: "Harborline Marina",
    tags: ["reminder"],
    subject: () => "Reminder: check-in tomorrow",
    body: (name) => ({
      html: `${para(`Hi ${name}, a reminder that your check-in is tomorrow. Fuel dock hours are 7 am to 6 pm.`)}`,
      text: `Hi ${name}, a reminder that your check-in is tomorrow. Fuel dock hours are 7 am to 6 pm.`,
    }),
  },
];

/** The stale-list blast behind harborline.co's stall. */
export const HARBORLINE_RENEWAL: Template = {
  key: "harborline-renewal",
  weight: 1,
  from: "reservations@harborline.co",
  fromName: "Harborline Marina",
  tags: ["renewal"],
  subject: () => "Harborline season pass renewal",
  body: (name) => ({
    html: `${heading("Renew your season pass")}${para(`Hi ${name}, season passes for 2027 are open. Renew by 31 October to keep your slip.`)}`,
    text: `Hi ${name}, season passes for 2027 are open. Renew by 31 October to keep your slip.`,
  }),
};

export const NORTHGATE_TEMPLATES: Template[] = [
  {
    key: "northgate-welcome",
    weight: 1,
    from: "hello@northgate.dev",
    fromName: "Northgate",
    tags: ["onboarding"],
    subject: () => "Welcome to Northgate",
    body: (name) => ({
      html: `${heading("Welcome aboard")}${para(`Hi ${name}, your Northgate account is ready.`)}`,
      text: `Hi ${name}, your Northgate account is ready.`,
    }),
  },
];

export interface BatchTemplate {
  key: string;
  from: string;
  fromName: string;
  tags: string[];
  subject: (index: number) => string;
  body: Body;
}

export const FIELD_GUIDE: BatchTemplate = {
  key: "field-guide",
  from: "news@fieldnotes.app",
  fromName: "Fieldnotes",
  tags: ["newsletter", "field-guide"],
  subject: (index) =>
    `Field guide #${index}: ${["Pressing leaves", "Tide tables", "Night skies", "Moss", "Reading clouds", "Trail etiquette", "Bird calls", "Mushrooms, carefully", "Winter tracks", "Seed saving", "Map folding", "Storm prep"][index % 12]}`,
  // HTML only, like most newsletter tools send it.
  body: {
    html: `${heading("This week in the field")}${para("Three short reads, one sketch prompt and a reader's photo.")}${para(link("https://fieldnotes.app/guide", "Read it on the web"))}`,
    text: null,
  },
};

export const PRODUCT_UPDATE: BatchTemplate = {
  key: "product-update",
  from: "news@fieldnotes.app",
  fromName: "Fieldnotes",
  tags: ["newsletter", "product"],
  subject: (index) => `What's new in Fieldnotes — ${["April", "May", "June", "July", "August", "September"][index % 6]}`,
  body: {
    html: `${heading("What's new")}${para("Offline sync, faster search and a darker dark mode.")}`,
    text: "What's new\n\nOffline sync, faster search and a darker dark mode.",
  },
};

export const RELEASE_NOTES: BatchTemplate = {
  key: "release-notes",
  from: "hi@scope.example",
  fromName: "Scope",
  tags: ["newsletter", "release-notes"],
  subject: (index) => `Scope release notes, ${["May", "July", "September"][index % 3]}`,
  body: {
    html: `${heading("Release notes")}${para("Timeline view, saved filters and SSO for every plan.")}`,
    text: "Release notes\n\nTimeline view, saved filters and SSO for every plan.",
  },
};

/** Hard bounces: [reason, SES bounce type, weight]. Skewed so the ranked list has a clear leader. */
export const BOUNCES: readonly (readonly [string, string, number])[] = [
  [
    "550 5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient's email address for typos or unnecessary spaces.",
    "Permanent/General",
    44,
  ],
  ["550 5.1.1 Recipient address rejected: User unknown in virtual mailbox table", "Permanent/NoEmail", 18],
  ["550 5.4.1 Recipient address rejected: Access denied. AS(201806281)", "Permanent/General", 11],
  ["552 5.2.2 The email account that you tried to reach is over quota and inactive.", "Permanent/General", 8],
  [
    "Amazon SES has suppressed sending to this address because it has a recent history of bouncing as an invalid address.",
    "Permanent/OnProviderSuppressionList",
    7,
  ],
  ["554 5.7.1 Service unavailable; Client host blocked using Spamhaus. To request removal from this list see https://www.spamhaus.org/query/lookup.lasso", "Permanent/General", 5],
  ["550 5.7.1 Message rejected due to content restrictions", "Permanent/ContentRejected", 3],
  ["553 5.1.3 The recipient address is not a valid RFC-5321 address.", "Permanent/General", 2],
];

/** Mailpace passes the receiving server's words through without a type. */
export const MAILPACE_BOUNCES: readonly (readonly [string, number])[] = [
  ["550 5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient's email address for typos or unnecessary spaces.", 46],
  ["550 5.1.1 Recipient address rejected: User unknown in virtual mailbox table", 22],
  ["550 5.4.1 Recipient address rejected: Access denied. AS(201806281)", 12],
  ["552 5.2.2 The email account that you tried to reach is over quota and inactive.", 10],
  ["554 5.7.1 Message rejected due to local policy", 6],
];

export const DEFERRALS: readonly (readonly [string, number])[] = [
  ["451 4.3.0 Mail server temporarily rejected message.", 30],
  ["TransientCommunicationFailure", 22],
  ["452 4.2.2 The email account that you tried to reach is over quota.", 16],
  ["421 4.7.0 [TSS04] Messages temporarily deferred due to unexpected volume or user complaints", 12],
  ["RecipientServerError", 10],
  ["451 4.7.500 Server busy. Please try again later.", 10],
];

/** Gmail's rate limit, the wording of the deferral burst. */
export const GMAIL_RATE_LIMIT =
  "421 4.7.28 Our system has detected an unusual rate of unsolicited mail originating from your IP address. To protect our users from spam, mail sent from your IP address has been temporarily rate limited.";

export const FAILURES: readonly (readonly [string, number])[] = [
  ["MessageRejected: Email address is not verified. The following identities failed the check in region US-WEST-2", 3],
  ["InvalidParameterValue: Missing final '@domain'", 4],
  ["554 5.7.1 Message rejected: sending domain is not authorized for this recipient.", 2],
  ["Illegal address", 3],
];

export const RETRIES: readonly (readonly [string, number])[] = [
  ["503 Service Unavailable", 5],
  ["Connection timed out after 30000ms", 3],
  ["502 Bad Gateway", 2],
];

export const SES_THROTTLE = "Throttling: Maximum sending rate exceeded.";

export function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

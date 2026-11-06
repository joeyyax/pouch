import { customAlphabet } from "nanoid";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const random = customAlphabet(ALPHABET, 24);

export const ID_PREFIXES = {
  message: "msg",
  domain: "dom",
  key: "key",
  event: "evt",
  inbound: "inb",
  address: "adr",
  thread: "thr",
  list: "lst",
  batch: "bat",
  organization: "org",
  /** Kept from provider_accounts (#375): live SES identity tags and registered webhook URLs carry these ids. */
  provider: "pac",
  dnsProviderAccount: "dpa",
  dnsProviderRecord: "dpr",
  suppression: "sup",
  webhookEndpoint: "whk",
  webhookDelivery: "whd",
  webhookAttempt: "wha",
  activity: "act",
  membership: "mem",
  invitation: "inv",
  export: "exp",
  digestPreferences: "dig",
  forwardTarget: "fwt",
  forward: "fwd",
  listMembership: "lmb",
  domainUnsubscribe: "dun",
  observationMute: "obm",
  dmarcReport: "dmr",
  dmarcReportRecord: "dmx",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${random()}`;
}

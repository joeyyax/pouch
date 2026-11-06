/** Read models for Admin settings → General: the service-wide policy an operator sets. */
import { domainOf } from "@/lib/addresses";
import { listVerifiedDomainNames, resolveSystemSender, SystemMailNotConfiguredError } from "@/lib/mail/system";
import { listSharedProviders } from "@/lib/providers/shared";
import { readServiceSettings } from "@/lib/settings/service";
import { adapterLabel } from "@/lib/dashboard/views/domains";
import { readReportHostSettings, reportHostProviders, verifyReportHost } from "@/lib/dmarc/host";

export interface SystemMailView {
  /** The address the setting holds, or null when it's unset. */
  address: string | null;
  /** The setting's two halves, for the local-part input and the domain select. */
  localPart: string | null;
  domain: string | null;
  /** Verified domain names, oldest first. The select's options, and empty means none exist. */
  verifiedDomains: string[];
  /** Where mail sends from right now, setting or default. Null means nothing resolves. */
  resolved: { address: string; domainName: string; organizationName: string } | null;
  /** The alert recipients the setting holds. Empty means alerts go to the from address. */
  alertsTo: string[];
  /** Set when the address doesn't resolve to a verified domain. */
  problem: string | null;
}

/** The system from address, split for the form, and what it resolves to. */
export async function readSystemMail(): Promise<SystemMailView> {
  const [{ systemFromAddress, systemAlertsTo }, verifiedDomains] = await Promise.all([readServiceSettings(), listVerifiedDomainNames()]);
  const at = systemFromAddress?.lastIndexOf("@") ?? -1;
  const parts =
    systemFromAddress && at > 0
      ? { localPart: systemFromAddress.slice(0, at), domain: domainOf(systemFromAddress) }
      : { localPart: null, domain: null };

  try {
    const sender = await resolveSystemSender();
    return {
      address: systemFromAddress,
      ...parts,
      alertsTo: systemAlertsTo ?? [],
      verifiedDomains,
      resolved: { address: sender.fromAddress, domainName: sender.domainName, organizationName: sender.organizationName },
      problem: null,
    };
  } catch (error) {
    if (!(error instanceof SystemMailNotConfiguredError)) throw error;
    return { address: systemFromAddress, ...parts, alertsTo: systemAlertsTo ?? [], verifiedDomains, resolved: null, problem: error.message };
  }
}

export interface DefaultProviderOption {
  id: string;
  name: string;
  adapterLabel: string;
  /** Tenants already on it. */
  organizationCount: number;
}

export interface DefaultProviderView {
  /** The provider new organizations are onboarded onto, or null when nothing is set. */
  selectedId: string | null;
  /** Shared providers, the only kind that can hold the default. Empty means none exist yet. */
  options: DefaultProviderOption[];
}

export interface DmarcReportHostRecord {
  type: string;
  name: string;
  value: string;
  priority?: number;
  /** What the zone holds now: `match`, `different`, `missing` or `unresolved`. */
  verdict: string;
  observed: string[];
}

export interface DmarcReportHostView {
  host: string | null;
  providerId: string | null;
  /** Shared providers that route received mail through their API. Empty means none can take the host. */
  options: { id: string; name: string; adapterLabel: string }[];
  /** The records to publish, checked live. Empty while no host is set. */
  records: DmarcReportHostRecord[];
  /** True once every record checks out, which is when domains get the `rua`. */
  verified: boolean;
}

/** The DMARC report host, its provider and its records as the zone holds them now. Checking stamps or clears verification. */
export async function readDmarcReportHost(): Promise<DmarcReportHostView> {
  const [settings, options, check] = await Promise.all([readReportHostSettings(), reportHostProviders(), verifyReportHost()]);
  return {
    host: settings.host,
    providerId: settings.providerId,
    options: options.map((option) => ({ id: option.id, name: option.name, adapterLabel: adapterLabel(option.adapter) })),
    records: (check?.checks ?? []).map(({ record, verdict, observed }) => ({
      type: record.type,
      name: record.name,
      value: record.value,
      ...(record.priority === undefined ? {} : { priority: record.priority }),
      verdict,
      observed,
    })),
    verified: check?.verified ?? false,
  };
}

/** The default provider for new organizations, and the shared providers it can name. */
export async function readDefaultProvider(): Promise<DefaultProviderView> {
  const shared = await listSharedProviders();
  return {
    selectedId: shared.find((provider) => provider.isDefault)?.id ?? null,
    options: shared.map((provider) => ({
      id: provider.id,
      name: provider.name,
      adapterLabel: adapterLabel(provider.adapter),
      organizationCount: provider.organizationCount,
    })),
  };
}

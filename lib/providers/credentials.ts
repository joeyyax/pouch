import { credentialsSchemaOf, settingsSchemaOf } from "@/lib/providers/adapters";

/** Validates a credentials JSON string against its adapter's schema. Unknown fields are dropped. */
export function parseCredentials(adapter: string, raw: string): Record<string, string> {
  return parseAgainst(adapter, credentialsSchemaOf(adapter), raw, "Credentials");
}

/** Validates a settings JSON string against its adapter's schema. An empty string means no settings. */
export function parseSettings(adapter: string, raw: string): Record<string, string> {
  return parseAgainst(adapter, settingsSchemaOf(adapter), raw.trim() || "{}", "Settings");
}

function parseAgainst(
  adapter: string,
  schema: ReturnType<typeof credentialsSchemaOf>,
  raw: string,
  label: string,
): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} for "${adapter}" must be a JSON object.`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || label.toLowerCase()}: ${issue.message}`);
    throw new Error(`${label} for "${adapter}" aren't valid. ${issues.join("; ")}`);
  }
  return result.data as Record<string, string>;
}

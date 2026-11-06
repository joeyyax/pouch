import Link from "next/link";
import { Code } from "@/components/code";
import { Terminal } from "@/components/ui/terminal";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "@/components/ui/tabs";
import type { SnippetLanguage } from "@/lib/dashboard/curl";
import { cn } from "@/lib/utils";
import { CodeCard } from "./code-card";

function Example({ language }: { language: SnippetLanguage }) {
  return language.language === "bash" ? (
    <Terminal command={language.code}>
      <Code language="bash" code={language.code} />
    </Terminal>
  ) : (
    <CodeCard code={language.code}>
      <Code language={language.language} code={language.code} />
    </CodeCard>
  );
}

/** A runnable request, one tab per language. */
export function Snippet({ languages, className }: { languages: SnippetLanguage[]; className?: string }) {
  const [first] = languages;
  if (!first) return null;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {languages.length === 1 ? (
        <Example language={first} />
      ) : (
        <TabsRoot defaultValue={first.id}>
          <TabsList size="sm" aria-label="Language">
            {languages.map((language) => (
              <TabsTrigger key={language.id} value={language.id}>
                {language.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {languages.map((language) => (
            <TabsContent key={language.id} value={language.id}>
              <Example language={language} />
            </TabsContent>
          ))}
        </TabsRoot>
      )}
      <Link href="/reference" className="type-body-sm self-start text-primary-strong underline underline-offset-4">
        Full API reference
      </Link>
    </div>
  );
}

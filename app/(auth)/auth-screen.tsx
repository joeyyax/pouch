import type { ReactNode } from "react";

export function AuthScreen({ title, lede, children }: { title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-8 px-6">
      <div>
        <h1 className="type-h3 text-foreground">{title}</h1>
        {lede ? <p className="type-body-sm mt-1 text-muted-foreground">{lede}</p> : null}
      </div>
      {children}
    </main>
  );
}

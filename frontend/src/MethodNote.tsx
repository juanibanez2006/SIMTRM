import type { ReactNode } from "react";

export default function MethodNote({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="panel method-note">
      <summary>{title}</summary>
      <div>{children}</div>
    </details>
  );
}

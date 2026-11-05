export interface Diagnostic {
  code: string;
  params?: Record<string, string | number>;
}

export interface Finding extends Diagnostic {
  level: "error" | "warn" | "info" | "ok";
  where?: string;
}

export type Issue = Omit<Finding, "level"> & { level: Exclude<Finding["level"], "ok"> };

export type SchemaCode = `career.schema.${string}`;
export type SchemaDiagnostic = Diagnostic & { code: SchemaCode };

interface VariableMode {
  modeId: string;
  name: string;
}

interface VariableCollection {
  id: string;
  name: string;
  modes: VariableMode[];
  variableIds: string[];
}

type VariableValue =
  | number
  | string
  | boolean
  | { r: number; g: number; b: number; a?: number }
  | { type: "VARIABLE_ALIAS"; id: string };

interface Variable {
  id: string;
  name: string;
  resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  valuesByMode: Record<string, VariableValue>;
  variableCollectionId: string;
}

export interface VariablesPayload {
  collections: VariableCollection[];
  variables: Variable[];
}

const DTCG_TYPE: Record<Variable["resolvedType"], string> = {
  COLOR: "color",
  FLOAT: "number",
  STRING: "string",
  BOOLEAN: "boolean",
};

function isAlias(value: VariableValue): value is { type: "VARIABLE_ALIAS"; id: string } {
  return typeof value === "object" && value !== null && (value as { type?: string }).type === "VARIABLE_ALIAS";
}

function isColor(value: VariableValue): value is { r: number; g: number; b: number; a?: number } {
  return typeof value === "object" && value !== null && "r" in value && "g" in value && "b" in value;
}

function toHex(channel: number): string {
  return Math.round(channel * 255)
    .toString(16)
    .padStart(2, "0");
}

function colorToCss(value: { r: number; g: number; b: number; a?: number }): string {
  const hex = `#${toHex(value.r)}${toHex(value.g)}${toHex(value.b)}`;
  return value.a !== undefined && value.a < 1 ? `${hex}${toHex(value.a)}` : hex;
}

function cssVarName(path: string[]): string {
  return `--${path.join("-").toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
}

function dtcgAliasRef(path: string[]): string {
  return `{${path.join(".")}}`;
}

/**
 * Разворачивает variables/collections из get_variables в DTCG JSON (один
 * файл на collection, по первому mode) и в плоский CSS-файл с custom
 * properties. Ссылки между переменными (VARIABLE_ALIAS) резолвятся в
 * DTCG-алиасы ({group.token}) и CSS var() соответственно.
 */
export function buildTokenExports(payload: VariablesPayload): { dtcg: Record<string, unknown>; css: string } {
  const variableById = new Map(payload.variables.map((v) => [v.id, v]));
  const pathById = new Map<string, string[]>();
  for (const v of payload.variables) {
    pathById.set(v.id, v.name.split("/"));
  }

  const dtcg: Record<string, unknown> = {};
  const cssLines: string[] = [":root {"];

  for (const collection of payload.collections) {
    const mode = collection.modes[0];
    if (!mode) continue;

    for (const variableId of collection.variableIds) {
      const variable = variableById.get(variableId);
      if (!variable) continue;

      const raw = variable.valuesByMode[mode.modeId];
      if (raw === undefined) continue;

      const path = pathById.get(variable.id) ?? [variable.name];

      let dtcgValue: unknown;
      let cssValue: string;

      if (isAlias(raw)) {
        const targetPath = pathById.get(raw.id) ?? [raw.id];
        dtcgValue = dtcgAliasRef(targetPath);
        cssValue = `var(${cssVarName(targetPath)})`;
      } else if (isColor(raw)) {
        dtcgValue = colorToCss(raw);
        cssValue = colorToCss(raw);
      } else {
        dtcgValue = raw;
        cssValue = String(raw);
      }

      let node = dtcg;
      for (const segment of path.slice(0, -1)) {
        node = (node[segment] ??= {}) as Record<string, unknown>;
      }
      node[path[path.length - 1]] = { $type: DTCG_TYPE[variable.resolvedType], $value: dtcgValue };

      cssLines.push(`  ${cssVarName(path)}: ${cssValue};`);
    }
  }

  cssLines.push("}");
  return { dtcg, css: cssLines.join("\n") };
}

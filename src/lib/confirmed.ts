import { searchServices } from "./catalog";
import type { ClientProfile } from "./formModel";

type Field = keyof ClientProfile;

// One value however it is written: "+7 900…" and "8 900…", "масло" and "Замена масла".
function canon(field: Field, value: string): string {
  if (field === "phone") return value.replace(/\D/g, "").slice(-10);
  if (field === "service") return searchServices(value)[0]?.id ?? value.trim().toLowerCase();
  return value.replace(/\s+/g, field === "plate" ? "" : " ").trim().toLowerCase();
}

/**
 * What the customer has said yes to in this call. The supervisor adds to it on a yes to a
 * read-back; update_form may save only what is in it, so the model cannot write what it merely heard.
 */
export interface Confirmed {
  add(patch: Partial<ClientProfile>): void;
  has(field: Field, value: string): boolean;
  clear(): void;
}

export function makeConfirmed(): Confirmed {
  const seen = new Map<Field, string>();
  return {
    add: (patch) => {
      for (const [k, v] of Object.entries(patch)) seen.set(k as Field, canon(k as Field, v));
    },
    has: (field, value) => !!value.trim() && seen.get(field) === canon(field, value),
    clear: () => seen.clear(),
  };
}

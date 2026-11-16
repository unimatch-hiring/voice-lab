import { useState } from "react";
import { CLEAR_PROFILE, FIELDS, formText, LABELS, REQUIRED, validate, type ClientProfile, type Lang } from "./lib/formModel";
import { saveFile } from "./lib/saveFile";
import "./clientForm.css";

// Only the agent sets the service, from the price list; the form shows it, last, as text.
const EDITABLE = FIELDS.filter((k) => k !== "service");

type Props = { value: ClientProfile; lang: Lang; onChange(next: ClientProfile): void; onClear(): void };

export function ClientForm({ value, lang, onChange, onClear }: Props) {
  const [touched, setTouched] = useState<Partial<Record<keyof ClientProfile, true>>>({});
  const errors = validate(value, lang);

  return (
    <form className="client-form" noValidate onSubmit={(e) => e.preventDefault()}>
      {EDITABLE.map((k) => {
        // A field the agent filled has content, so it is checked without ever being blurred.
        const error = (touched[k] || value[k]) && errors[k];
        return (
          <label key={k}>
            {LABELS[lang][k]}
            {REQUIRED.includes(k) ? " *" : ""}
            <input
              value={value[k]}
              type={k === "phone" ? "tel" : "text"}
              aria-invalid={error ? true : undefined}
              onChange={(e) => onChange({ ...value, [k]: e.target.value })}
              onBlur={() => setTouched((t) => ({ ...t, [k]: true }))}
            />
            {error && (
              <span className="field-error" role="alert">
                {error}
              </span>
            )}
          </label>
        );
      })}
      <section className="form-service" aria-label={LABELS[lang].service}>
        <h3>{LABELS[lang].service}</h3>
        <p className={value.service ? undefined : "form-service-empty"}>{value.service || "—"}</p>
      </section>
      <div className="form-actions">
        <button type="button" className="form-download" onClick={() => download(formText(value, lang))}>
          download form
        </button>
        <button
          type="button"
          className="form-clear"
          onClick={() => {
            // An emptied form is a fresh one: no "required" under fields nobody has left yet.
            setTouched({});
            onClear();
          }}
        >
          {CLEAR_PROFILE[lang]}
        </button>
      </div>
    </form>
  );
}

function download(text: string) {
  saveFile(`form-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`, text);
}

import { useState } from "react";
import { FIELDS, formText, LABELS, REQUIRED, validate, type ClientProfile, type Lang } from "./lib/formModel";
import "./clientForm.css";

type Props = { value: ClientProfile; lang: Lang; onChange(next: ClientProfile): void };

export function ClientForm({ value, lang, onChange }: Props) {
  const [touched, setTouched] = useState<Partial<Record<keyof ClientProfile, true>>>({});
  const errors = validate(value, lang);

  return (
    <form className="client-form" noValidate onSubmit={(e) => e.preventDefault()}>
      {FIELDS.map((k) => {
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
      <button type="button" className="form-download" onClick={() => download(formText(value, lang))}>
        download form
      </button>
    </form>
  );
}

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `form-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

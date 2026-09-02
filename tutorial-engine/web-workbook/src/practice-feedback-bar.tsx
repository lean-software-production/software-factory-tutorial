import React from "react";
import { Markdown } from "./markdown.js";

export type PracticeFeedbackTone = "status" | "feedback" | "updating" | "failure" | "success";

export function PracticeFeedbackBar({ tone, markdown, status, label, title, busy = false, className = "", id }: { tone: PracticeFeedbackTone; markdown?: string; status?: string; label?: string; title?: string; busy?: boolean; className?: string; id?: string }) {
  const classes = [`practice-feedback-bar is-${tone}`, busy ? "is-busy" : "", className].filter(Boolean).join(" ");
  return <aside id={id} className={classes} aria-live="polite" aria-atomic="true" role="status">
    {tone === "success" && <span className="success-check" aria-hidden="true">✓</span>}
    <div className="practice-feedback-content">
      {label && <p className="section-label">{label}</p>}
      {title && <h3>{title}</h3>}
      {markdown && <Markdown source="generated">{markdown}</Markdown>}
      {status && <p className="practice-feedback-status">{busy && <span className="practice-feedback-spinner" aria-hidden="true" />}{status}</p>}
    </div>
  </aside>;
}

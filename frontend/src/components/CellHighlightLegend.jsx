/** Legend for empty-field, AI-normalized, and Excel-imported cell highlights. */
export default function CellHighlightLegend({
  className = "",
  variant = "vessels",
  showMissing = false,
  importedLabel = "Owners directory",
}) {
  const isContacts = variant === "contacts";
  return (
    <div className={`vf-legends ${className}`.trim()}>
      {isContacts && (
        <div className="contact-import-legend" title="Contacts imported from the owners Excel list">
          <span className="contact-import-legend-swatch" aria-hidden="true" />
          <span>{importedLabel}</span>
        </div>
      )}
      {(showMissing || !isContacts) && (
        <div className="vf-legend">
          <span className="vf-legend-swatch missing" aria-hidden="true" />
          <span>Missing fields</span>
        </div>
      )}
      {!isContacts && (
        <div className="vf-legend">
          <span className="vf-legend-swatch ai-norm" aria-hidden="true" />
          <span>Fields corrected by AI</span>
        </div>
      )}
    </div>
  );
}

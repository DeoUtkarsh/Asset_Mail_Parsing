/** Legend for empty-field and AI-normalized cell highlights. */
export default function CellHighlightLegend({ className = "" }) {
  return (
    <div className={`vf-legends ${className}`.trim()}>
      <div className="vf-legend">
        <span className="vf-legend-swatch missing" aria-hidden="true" />
        <span>Missing fields</span>
      </div>
      <div className="vf-legend">
        <span className="vf-legend-swatch ai-norm" aria-hidden="true" />
        <span>Fields corrected by AI</span>
      </div>
    </div>
  );
}

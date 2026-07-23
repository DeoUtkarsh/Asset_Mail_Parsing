/** Legend for empty-field and AI-normalized cell highlights. */
export default function CellHighlightLegend({ className = "" }) {
  return (
    <div className={`vf-legends ${className}`.trim()}>
      <div className="vf-legend">
        <span className="vf-legend-swatch missing" aria-hidden="true" />
        <span>System detected that the fields are empty</span>
      </div>
      <div className="vf-legend">
        <span className="vf-legend-swatch ai-norm" aria-hidden="true" />
        <span>AI normalised the cells</span>
      </div>
    </div>
  );
}

import { useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// Bundle the pdf.js worker with Vite (renders PDFs in-app, like Gmail —
// independent of the browser's "download PDFs" setting).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export default function PdfView({ url }) {
  const [numPages, setNumPages] = useState(0);

  return (
    <div className="pdfview">
      <Document
        file={url}
        onLoadSuccess={({ numPages }) => setNumPages(numPages)}
        loading={<div className="pdf-msg">Loading PDF…</div>}
        error={<div className="pdf-msg">Couldn’t render this PDF — use Download instead.</div>}
      >
        {Array.from({ length: numPages }, (_, i) => (
          <Page
            key={i}
            pageNumber={i + 1}
            width={820}
            renderTextLayer={false}
            renderAnnotationLayer={false}
            className="pdf-page"
            loading=""
          />
        ))}
      </Document>
    </div>
  );
}

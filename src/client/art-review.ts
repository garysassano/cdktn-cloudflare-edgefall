interface StudyReview {
  id: string;
  file: string;
  prompt: string;
  sha256: string;
  requested: {
    nativeWidth: number;
    nativeHeight: number;
    pixelScale: number;
    columns: number;
    rows: number;
  };
  artAssessment: { issues: string[] };
  image: {
    width: number;
    height: number;
    alpha: { transparent: number; opaque: number; partial: number; hiddenRgb: number };
    visibleColors: number | string;
    canImportUnchanged: boolean;
    findings: Array<{ code: string; message: string }>;
  };
}
function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing review control ${id}`);
  return found as T;
}
async function startReview() {
  const response = await fetch("/art-review/report.json");
  if (!response.ok) throw new Error("Source review report could not be loaded");
  const report = (await response.json()) as { studies: StudyReview[]; sourceIntegrity: string };
  if (!report.studies.length || report.sourceIntegrity !== "pass")
    throw new Error("Invalid source review");
  const select = element<HTMLSelectElement>("study"),
    background = element<HTMLSelectElement>("background"),
    zoom = element<HTMLSelectElement>("zoom"),
    showGrid = element<HTMLInputElement>("show-grid"),
    sheet = element<HTMLImageElement>("sheet");
  for (const [index, study] of report.studies.entries())
    select.add(new Option(study.id, String(index)));
  const update = () => {
    const study = report.studies[Number(select.value)];
    if (!study) throw new Error("Missing selected study");
    sheet.src = `/art-review/${study.file.split("/").at(-1)}`;
    sheet.style.width = `${zoom.value === "native" ? study.requested.nativeWidth : study.image.width * Number(zoom.value)}px`;
    element("viewport").style.backgroundColor = background.value;
    const grid = element("grid");
    grid.hidden = !showGrid.checked;
    grid.style.backgroundSize = `${100 / study.requested.columns}% ${100 / study.requested.rows}%`;
    element("status").textContent = study.image.canImportUnchanged
      ? "Pixel checks passed. Human review and authored animation are still pending."
      : "Production import rejected · concept source retained · human style review pending";
    element("caption").textContent =
      zoom.value === "native"
        ? `Resampled concept preview at ${study.requested.nativeWidth}×${study.requested.nativeHeight} logical size. This does not create or approve native pixel art.`
        : `Original ${study.image.width}×${study.image.height} source at ${Number(zoom.value) * 100}%. Grid lines show requested cells, not validated frame crops.`;
    const metrics = element("metrics");
    metrics.replaceChildren();
    for (const [label, value] of [
      ["Actual image", `${study.image.width} × ${study.image.height}`],
      [
        "Requested image",
        `${study.requested.nativeWidth * study.requested.pixelScale} × ${study.requested.nativeHeight * study.requested.pixelScale}`,
      ],
      ["Transparent pixels", study.image.alpha.transparent.toLocaleString()],
      ["Opaque pixels", study.image.alpha.opaque.toLocaleString()],
      ["Partial alpha", study.image.alpha.partial.toLocaleString()],
      ["Hidden colored pixels", study.image.alpha.hiddenRgb.toLocaleString()],
      ["Visible RGB colors", String(study.image.visibleColors)],
    ]) {
      const dt = document.createElement("dt"),
        dd = document.createElement("dd");
      dt.textContent = label ?? "";
      dd.textContent = value ?? "";
      metrics.append(dt, dd);
    }
    const findings = element("findings");
    findings.replaceChildren();
    for (const message of [
      ...study.image.findings.map((finding) => finding.message),
      ...study.artAssessment.issues,
    ]) {
      const item = document.createElement("li");
      item.textContent = message;
      findings.append(item);
    }
    const source = element("source");
    source.replaceChildren();
    const link = document.createElement("a");
    link.href = `/art-review/${study.prompt.split("/").at(-1)}`;
    link.textContent = "Read the exact generation prompt";
    source.append(link, document.createTextNode(` · Source SHA-256: ${study.sha256}`));
    element("provenance").textContent = JSON.stringify(study, null, 2);
    document.documentElement.dataset.reviewStudy = study.id;
  };
  for (const control of [select, background, zoom, showGrid])
    control.addEventListener("change", update);
  update();
}
startReview().catch((error: unknown) => {
  element("status").textContent = error instanceof Error ? error.message : "Source review failed";
});

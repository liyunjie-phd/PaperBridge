import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("TeX source API saves atomically, rejects stale edits, and retains three backups", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-source-api-"));
  const projectRoot = path.join(root, "project");
  const dataRoot = path.join(root, "data");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\input{section}",
      "\\bibliographystyle{plain}",
      "\\bibliography{refs}",
      "\\end{document}"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(projectRoot, "section.tex"), "Original section text.\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "refs.bib"), "@misc{example, title={Original reference}}\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "unused.bib"), "@misc{unused, title={Unused reference}}\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "unused.tex"), "Not part of the paper.\n", "utf8");

    const server = await startServer({ port: 0, dataRoot, projectsRoot: path.join(root, "projects") });
    const request = async (url, options = {}) => {
      const response = await fetch(`${server.url}${url}`, {
        headers: { "Content-Type": "application/json" },
        ...options
      });
      const payload = await response.json();
      return { response, payload };
    };
    const post = (url, body) => request(url, { method: "POST", body: JSON.stringify(body) });
    const provider = {
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };

    let result = await post("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false
    });
    assert.equal(result.response.ok, true, result.payload.error);
    assert.deepEqual(result.payload.texFiles, ["main.tex", "section.tex"]);
    assert.deepEqual(result.payload.bibliographyFiles, ["refs.bib"]);
    assert.deepEqual(result.payload.sourceFiles, ["main.tex", "section.tex", "unused.tex", "refs.bib"]);
    assert.equal(result.payload.structure.mode, "modular");
    assert.deepEqual(result.payload.structure.workflow.local.files, ["section.tex"]);

    result = await request("/api/source?file=section.tex");
    assert.equal(result.response.ok, true, result.payload.error);
    const originalHash = result.payload.sourceHash;
    assert.equal(result.payload.content, "Original section text.\n");
    assert.equal(result.payload.eol, "\n");

    result = await post("/api/source", {
      file: "section.tex",
      content: "First PaperBridge edit.\n",
      sourceHash: originalHash,
      deferCompile: true
    });
    assert.equal(result.response.ok, true, result.payload.error);
    assert.equal(result.payload.build, null);
    assert.equal(result.payload.document, null);
    assert.equal(result.payload.project, undefined);
    assert.equal(await fs.readFile(path.join(projectRoot, "section.tex"), "utf8"), "First PaperBridge edit.\n");

    const stale = await post("/api/source", {
      file: "section.tex",
      content: "Stale edit.\n",
      sourceHash: originalHash
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.payload.code, "SOURCE_CHANGED");

    let source = result.payload.source;
    for (let index = 0; index < 4; index += 1) {
      result = await post("/api/source", {
        file: "section.tex",
        content: `Saved revision ${index}.\n`,
        sourceHash: source.sourceHash
      });
      assert.equal(result.response.ok, true, result.payload.error);
      source = result.payload.source;
    }

    const backupRoot = path.join(dataRoot, "source-backups");
    const backupFiles = (await fs.readdir(backupRoot, { recursive: true })).filter((name) => name.endsWith(".bak"));
    assert.equal(backupFiles.length, 3);

    result = await request("/api/source?file=refs.bib");
    assert.equal(result.response.ok, true, result.payload.error);
    const bibHash = result.payload.sourceHash;
    result = await post("/api/source", {
      file: "refs.bib",
      content: "@misc{example, title={Updated reference}}\n",
      sourceHash: bibHash
    });
    assert.equal(result.response.ok, true, result.payload.error);
    assert.match(await fs.readFile(path.join(projectRoot, "refs.bib"), "utf8"), /Updated reference/);

    const unusedTex = await request("/api/source?file=unused.tex");
    assert.equal(unusedTex.response.ok, true, unusedTex.payload.error);
    assert.equal(unusedTex.payload.content, "Not part of the paper.\n");
    const unusedBib = await request("/api/source?file=unused.bib");
    assert.equal(unusedBib.response.ok, false);
    const escaped = await request("/api/source?file=..%2Foutside.tex");
    assert.equal(escaped.response.ok, false);
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("TeX source editor soft-wraps long lines without adding a toggle", async () => {
  const indexHtml = await fs.readFile(path.join(process.cwd(), "public", "index.html"), "utf8");
  const styles = await fs.readFile(path.join(process.cwd(), "public", "styles.css"), "utf8");
  assert.match(indexHtml, /id="sourceEditor"[\s\S]*wrap="soft"/);
  assert.doesNotMatch(indexHtml, /sourceWrapButton/);
  assert.match(styles, /\.source-editor\s*\{[\s\S]*white-space:\s*pre-wrap;/);
  assert.match(styles, /\.source-editor\s*\{[\s\S]*overflow-wrap:\s*anywhere;/);
});

test("TeX source save avoids blocking on a full project refresh", async () => {
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const serverJs = await fs.readFile(path.join(process.cwd(), "server.js"), "utf8");

  const saveStart = appJs.indexOf("async function saveSourceFile");
  const saveEnd = appJs.indexOf("async function createTexFile", saveStart);
  const saveBlock = appJs.slice(saveStart, saveEnd);
  assert.match(saveBlock, /const deferCompile = options\.deferCompile \?\? true;/);
  assert.doesNotMatch(saveBlock, /autoCompile/);
  assert.match(saveBlock, /refreshDocument:\s*options\.refreshDocument === true/);
  assert.doesNotMatch(saveBlock, /scheduleProjectRefresh/);
  assert.match(serverJs, /const refreshDocument = req\.body\.refreshDocument === true;/);
  assert.match(serverJs, /const deferCompile = req\.body\.deferCompile !== false;/);
  assert.doesNotMatch(serverJs, /document:\s*nextDocument[\s\S]{0,120}project:\s*await getProjectPayload\(\)/);
});

test("PDF export shows visible progress until save finishes", async () => {
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const start = appJs.indexOf("async function exportPdf()");
  const end = appJs.indexOf("function setMode", start);
  const block = appJs.slice(start, end);

  assert.match(appJs, /pdfExportToken:\s*0/);
  assert.match(appJs, /exportPdfButton:\s*document\.querySelector\("#exportPdfButton"\)/);
  assert.match(appJs, /elements\.exportPdfButton\.addEventListener\("click",\s*exportPdf\)/);
  assert.match(block, /setBusy\(elements\.exportPdfButton,\s*true\)/);
  assert.match(block, /正在保存 PDF/);
  assert.match(block, /PDF 已保存/);
  assert.match(block, /PDF 下载已开始/);
  assert.match(block, /PDF 保存失败/);
  assert.match(block, /setBusy\(elements\.exportPdfButton,\s*false\)/);
  assert.match(block, /state\.pdfExportToken === exportToken/);
});

test("current TeX translation continues as a background file job after switching files", async () => {
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const start = appJs.indexOf("async function translateCurrentFile()");
  const end = appJs.indexOf("function formatFileName", start);
  const block = appJs.slice(start, end);

  assert.match(appJs, /fileTranslationJobs:\s*new Map\(\)/);
  assert.match(block, /const translationFile = state\.currentFile;/);
  assert.match(block, /state\.fileTranslationJobs\.has\(translationFile\)/);
  assert.doesNotMatch(block, /setBusy\(button,\s*true\)/);
  assert.doesNotMatch(block, /file:\s*state\.currentFile/);
  assert.match(block, /file:\s*translationFile/);
  assert.match(block, /if \(state\.currentFile === translationFile\)/);
  assert.match(appJs, /state\.currentDocument = null;[\s\S]{0,140}renderFileTranslationProgress\(file\)/);
  assert.match(appJs, /renderFileTranslationProgress\(state\.currentFile\)/);
});

test("paragraph translation clicks enqueue jobs instead of waiting for the current request", async () => {
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const serverJs = await fs.readFile(path.join(process.cwd(), "server.js"), "utf8");
  const createStart = appJs.indexOf("function createSegmentRow");
  const createEnd = appJs.indexOf("function fitMathBlockEditor", createStart);
  const createBlock = appJs.slice(createStart, createEnd);
  const clickStart = createBlock.indexOf('translateButton.addEventListener("click"');
  const clickEnd = createBlock.indexOf("});", clickStart);
  const clickBlock = createBlock.slice(clickStart, clickEnd);
  const queueStart = appJs.indexOf("function enqueueSegmentTranslation");
  const queueEnd = appJs.indexOf("function createSegmentRow", queueStart);
  const queueBlock = appJs.slice(queueStart, queueEnd);

  assert.match(appJs, /const MAX_PARALLEL_SEGMENT_TRANSLATIONS = 6;/);
  assert.match(serverJs, /PAPERBRIDGE_TRANSLATION_CONCURRENCY \|\| 6/);
  assert.match(appJs, /segmentTranslationJobs:\s*new Map\(\)/);
  assert.match(appJs, /segmentTranslationQueue:\s*\[\]/);
  assert.match(appJs, /activeSegmentTranslations:\s*0/);
  assert.match(appJs, /function enqueueSegmentTranslation/);
  assert.match(appJs, /function runSegmentTranslationQueue/);
  assert.match(appJs, /function applySegmentTranslationState/);
  assert.match(createBlock, /applySegmentTranslationState\(row,\s*segment\)/);
  assert.match(clickBlock, /enqueueSegmentTranslation\(\{\s*\.\.\.segment,\s*sourceHash:\s*latestSourceHash\(\)\s*\},\s*chinese\.value\)/);
  assert.doesNotMatch(clickBlock, /await api\("\/api\/segment\/translate"/);
  assert.match(queueBlock, /state\.activeSegmentTranslations < MAX_PARALLEL_SEGMENT_TRANSLATIONS/);
  assert.match(queueBlock, /status:\s*"queued"/);
  assert.match(queueBlock, /status = "running"/);
  assert.match(queueBlock, /api\("\/api\/segment\/translate"/);
});

test("English paragraph edits autosave to TeX and confirm protected LaTeX token deletion", async () => {
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const serverJs = await fs.readFile(path.join(process.cwd(), "server.js"), "utf8");
  const createStart = appJs.indexOf("function createSegmentRow");
  const createEnd = appJs.indexOf("function fitMathBlockEditor", createStart);
  const createBlock = appJs.slice(createStart, createEnd);
  const inputStart = createBlock.indexOf('english.addEventListener("input"');
  const inputEnd = createBlock.indexOf("});", inputStart);
  const inputBlock = createBlock.slice(inputStart, inputEnd);
  const saveStart = createBlock.indexOf("async function saveEnglish");
  const saveEnd = createBlock.indexOf("saveEnglishButton.addEventListener", saveStart);
  const saveBlock = createBlock.slice(saveStart, saveEnd);

  assert.match(appJs, /function segmentEnglishSaveTimerKey/);
  assert.match(inputBlock, /markEnglishChanged\("英文待自动保存"\)/);
  assert.match(inputBlock, /scheduleEnglishAutosave\(\)/);
  assert.match(saveBlock, /options\.automatic === true/);
  assert.match(saveBlock, /sourceHash:\s*latestSourceHash\(\)/);
  assert.match(saveBlock, /english:\s*requestedEnglish/);
  assert.doesNotMatch(saveBlock, /renderSegments\(\)/);
  assert.match(saveBlock, /window\.confirm\(`修改删除了 LaTeX 标记/);
  assert.match(saveBlock, /forceRetry = true/);
  assert.match(saveBlock, /return saveEnglish\(true,\s*\{\s*automatic\s*\}\)/);
  assert.match(serverJs, /findMissingProtectedTokens\(segment\.english, segment\.chinese, nextEnglish\)[\s\S]{0,100}\.filter\(\(token\) => !isOptionalTranslationToken\(token\)\)/);
});

test("sidebar owns project switching and new TeX while source view follows the selected document", async () => {
  const indexHtml = await fs.readFile(path.join(process.cwd(), "public", "index.html"), "utf8");
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const styles = await fs.readFile(path.join(process.cwd(), "public", "styles.css"), "utf8");

  assert.match(indexHtml, /id="sidebarProjectList"/);
  assert.match(indexHtml, /id="createTexFileButton"[\s\S]*id="documentList"/);
  assert.match(indexHtml, /id="createTexDialog"[\s\S]*id="newTexFileName"[\s\S]*id="newTexInsertion"/);
  assert.doesNotMatch(indexHtml, /source-file-select[\s\S]{0,260}id="createTexFileButton"/);
  assert.match(appJs, /function renderSidebarProjectList/);
  assert.match(appJs, /function openCreateTexDialog/);
  assert.match(appJs, /mode:\s*"after-section"/);
  assert.match(appJs, /elements\.createTexDialog\.showModal\(\)/);
  assert.match(appJs, /renderSourceFileOptions\(file\)/);
  assert.match(appJs, /renderSourceFileOptions\(loadCurrent \? state\.currentFile : state\.sourceFile\)/);
  assert.doesNotMatch(appJs, /insert-figure-button/);
  assert.match(styles, /\.project-switch-button/);
});

test("TeX source changes autosave without compiling and refresh the bilingual document", async () => {
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const saveStart = appJs.indexOf("async function saveSourceFile");
  const saveBlock = appJs.slice(saveStart, appJs.indexOf("function texHeadingOptions", saveStart));
  const inputStart = appJs.indexOf('elements.sourceEditor.addEventListener("input"');
  const inputBlock = appJs.slice(inputStart, appJs.indexOf('elements.sourceEditor.addEventListener("scroll"', inputStart));

  assert.match(saveBlock, /refreshDocument:\s*options\.refreshDocument === true \|\| requestedFile\.toLowerCase\(\)\.endsWith\("\.tex"\)/);
  assert.match(saveBlock, /const deferCompile = options\.deferCompile \?\? true/);
  assert.match(inputBlock, /scheduleSourceAutosave\(\)/);
  assert.match(appJs, /await refreshLoadedSourceFromDisk\(result\.document\.file\)/);
});

test("paragraph comment UI defers compilation unless auto compile is enabled", async () => {
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const serverJs = await fs.readFile(path.join(process.cwd(), "server.js"), "utf8");
  const commentStart = appJs.indexOf('api("/api/segment/comment"');
  const commentBlock = appJs.slice(commentStart, appJs.indexOf("});", commentStart));
  assert.match(commentBlock, /deferCompile:\s*state\.project\?\.config\?\.autoCompile !== true/);
  const serverStart = serverJs.indexOf("async function commentParagraph");
  const serverBlock = serverJs.slice(serverStart, serverJs.indexOf("async function saveMathBlock", serverStart));
  assert.match(serverBlock, /deferCompile = true/);
  assert.match(serverBlock, /build: deferCompile \? null : await maybeCompile/);
});

test("paragraph comments are exposed from the selection context menu instead of the row toolbar", async () => {
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const rowStart = appJs.indexOf('row.innerHTML = `');
  const rowBlock = appJs.slice(rowStart, appJs.indexOf("`;", rowStart));
  assert.doesNotMatch(rowBlock, /comment-paragraph-button/);
  assert.match(appJs, /注释选中内容/);
  assert.match(appJs, /segmentRow\?\.commentParagraphAction/);
  assert.match(appJs, /async \(trigger = null\) =>/);
});

test("table editor exposes a single English grid with row and column context actions", async () => {
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const styles = await fs.readFile(path.join(process.cwd(), "public", "styles.css"), "utf8");
  const tableStart = appJs.indexOf("function createTableBlockRow");
  const tableBlock = appJs.slice(tableStart, appJs.indexOf("function openParagraphDialog", tableStart));

  assert.match(tableBlock, /英文表格/);
  assert.doesNotMatch(tableBlock, /chinese-table/);
  assert.match(appJs, /row-before/);
  assert.match(appJs, /row-after/);
  assert.match(appJs, /column-before/);
  assert.match(appJs, /column-after/);
  assert.match(appJs, /row-delete/);
  assert.match(appJs, /column-delete/);
  assert.match(tableBlock, /右键单元格可添加或删除行列/);
  assert.match(styles, /\.table-context-menu/);
  assert.match(styles, /\.table-cell-selected/);
});

test("PDF double-click navigation constrains matches by page text and source order", async () => {
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const matcherStart = appJs.indexOf("function scoreNavigationText(");
  const matcherBlock = appJs.slice(matcherStart, appJs.indexOf("async function getPdfParagraphIndex", matcherStart));
  const queryStart = appJs.indexOf("function extractPdfNavigationQuery(");
  const queryBlock = appJs.slice(queryStart, appJs.indexOf("function highlightLocatedSegment", queryStart));
  const locateStart = appJs.indexOf("async function locatePdfSelection(");
  const locateBlock = appJs.slice(locateStart, appJs.indexOf("async function locateFastPreviewSelection", locateStart));
  const captionMatch = locateBlock.indexOf("getPdfCaptionIndex()");
  const paragraphMatch = locateBlock.indexOf("getPdfParagraphIndex()");

  assert.match(matcherBlock, /scoreNavigationPageEvidence/);
  assert.match(matcherBlock, /scoreNavigationPosition/);
  assert.match(matcherBlock, /captionReliable/);
  assert.match(matcherBlock, /positionPenalty/);
  assert.match(queryBlock, /pageText:\s*items\.filter\(Boolean\)\.join\(" "\)/);
  assert.match(queryBlock, /state\.pdfDocument\?\.numPages\s*\|\|\s*state\.project\?\.pdf\?\.pages/);
  assert.match(appJs, /positionRatio:\s*entries\.length <= 1 \? 0 : index \/ denominator/);
  assert.match(appJs, /function extractLatexCaptions/);
  assert.match(appJs, /function getPdfCaptionIndex/);
  assert.ok(captionMatch >= 0 && paragraphMatch >= 0 && captionMatch < paragraphMatch);
  assert.match(locateBlock, /const navigationScope = \{[\s\S]*page:\s*query\.page[\s\S]*pageText:\s*query\.pageText/);
  assert.match(locateBlock, /findBestNavigationMatch\(query\.context,\s*query\.selectedText,\s*await getPdfCaptionIndex\(\),\s*\{[\s\S]*caption:\s*true/);
  assert.match(locateBlock, /findBestNavigationMatch\(query\.context,\s*query\.selectedText,\s*await getPdfParagraphIndex\(\),\s*navigationScope\)/);
});

test("TeX source navigation and search visibly pulse the located selection", async () => {
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const styles = await fs.readFile(path.join(process.cwd(), "public", "styles.css"), "utf8");
  const openStart = appJs.indexOf("async function openSourceLocation");
  const openBlock = appJs.slice(openStart, appJs.indexOf("function renderCompileDiagnosis", openStart));
  const searchStart = appJs.indexOf("function selectSourceSearchMatch");
  const searchBlock = appJs.slice(searchStart, appJs.indexOf("function moveSourceSearch", searchStart));

  assert.match(appJs, /function flashSourceSelection/);
  assert.match(openBlock, /setSelectionRange\(start,\s*end\)[\s\S]*flashSourceSelection\(\)/);
  assert.match(searchBlock, /setSelectionRange\(match\.start,\s*match\.end\)[\s\S]*flashSourceSelection\(\)/);
  assert.match(styles, /\.source-editor\.source-located/);
  assert.match(styles, /@keyframes sourceLocatedPulse/);
});

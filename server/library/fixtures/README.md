# Library test fixtures

Small sample files for the document-library extractors. All strings below were observed by running the
installed libraries (unpdf 1.9.1, mammoth 1.13.0 + node-html-markdown 2.0.0, word-extractor 1.0.4,
fflate 0.8.3 + fast-xml-parser 5.12.1, xlsx 0.20.3) under tsx on Node 22. Total size is about 146 KB.

`old-deck.ppt` (sample.ppt, 480,256 bytes) was NOT copied: it exceeds the 300 KB per-file limit.

| Fixture | Format | Contents and exact assertions |
|---|---|---|
| `report.pdf` | PDF, 3 pages | unpdf `extractText(pdf, {mergePages:false})` gives 3 page strings (193/194/194 chars). Page 1 starts `Chapter 1: Quarterly Findings\nThis is page 1. The quick brown fox jumps over the lazy dog. Revenue grew by 7 percent.\nLigatures: office, affluent, fi`; page 2 `Chapter 2: ...This is page 2. ... Revenue grew by 14 percent.`; page 3 `Chapter 3: ...This is page 3. ... Revenue grew by 21 percent.` |
| `scan.pdf` | PDF, 2 pages, image only | `totalPages` 2; both page strings are `""` (length 0). No exception. |
| `locked.pdf` | PDF, password-protected | `getDocumentProxy` throws `err.name === "PasswordException"`, `err.message === "No password given"`. |
| `broken.pdf` | truncated PDF (700 bytes) | `getDocumentProxy` throws `InvalidPDFException`, message `"Invalid PDF structure."` (pdf.js also logs `Warning: Indexing all PDF objects`). `fake.pdf` behaves identically; `truncated.pdf` was used as requested. |
| `report.docx` | DOCX | mammoth `extractRawText`: `"Annual Report\n\nIntro with bold and italic text. Café Zürich 日本語.\n\nMethods\n\nFirst bullet\n\nSecond bullet\n\nName\n\nScore\n\nAlice\n\n90\n\nConclusion text here.\n"`. `convertToHtml` then `NodeHtmlMarkdown().translate` gives `# Annual Report\n\nIntro with **bold** and _italic_ text. Café Zürich 日本語.\n\n## Methods\n\n* First bullet\n* Second bullet\n\n\| Name  \| Score \|\n\| ----- \| ----- \|\n\| Alice \| 90    \|\n\nConclusion text here.` |
| `broken.docx` | truncated DOCX zip (3000 bytes) | mammoth throws `Error`, message `Corrupted zip: can't find end of central directory`. |
| `memo.doc` | legacy Word 97 | word-extractor `getBody()`: `"Annual Report\nIntro with bold and italic text. Café Zürich 日本語.\nMethods\nFirst bullet\nSecond bullet\nName\tScore\t\nAlice\t90\t\nConclusion text here.\n"`; `getHeaders()` and `getFootnotes()` are `""`. |
| `deck.pptx` | PPTX, 11 slides | In presentation order via `ppt/presentation.xml` sldIdLst. Slide 1 text `Title Slide: Roadmap\nBullet one\nBullet two`, notes `Speaker note for slide one: mention budget.`. Slide 2 text `Slide Two: Metrics\nQ1\nQ2\n10\n20`, notes `Notes two.`. Slide 3 `Slide Three: Wrap-up`, no notes. Slides 4-11 are `Filler slide number N` (N = 4..11), no notes. |
| `sales.xlsx` | XLSX, 3 sheets | `XLSX.read(buf,{type:'buffer',cellDates:true})` sheet names `["Sales","Notes","Hidden"]` (Hidden is a hidden sheet, content `[["hidden data"]]`). With `sheet_to_json(ws,{header:1,raw:false,blankrows:false})`: Sales `[["Region","Units","Price","Date","Total"],["North","10","2.5","1/15/26","25"],["South","7","3.25","2/1/26","22.75"]]`; Notes `[["Comment"],["Café, with \"quotes\" and\nnewline"],["Hyperlink"]]`. |
| `sales.xls` | legacy XLS, same data | Same sheet names and rows as `sales.xlsx`, except the Date column comes back as serial numbers: `["North","10","2.5","46037","25"]`, `["South","7","3.25","46054","22.75"]`. xlsx prints `Codepage tables are not loaded.  Non-ASCII characters may not give expected results` on stderr/console when reading .xls (text still decoded correctly here). |
| `page.html` | HTML | `new NodeHtmlMarkdown({ignore:['nav','footer','script','style']}).translate(html)` gives `# Main Heading\n\nParagraph with [a link](https://example.com) and **bold**.\n\n## Sub\n\n* One\n* Two\n\n\| A \| B \|\n\| - \| - \|\n\| 1 \| 2 \|\n\n```\nconst x = 1;\n````. Ignored: `Menu Home About`, `Footer junk`. `<title>` is `T`. |
| `letter.rtf` | RTF | `rtfToText` (from `t/rtf.ts`) gives `Heading\nHello world, café and € euro 日本.\nSecond paragraph.` |
| `unicode.rtf` | RTF with `\u` escapes | `rtfToText` gives `AéB è¤?C â5?â2?D 😀E`. The file itself contains mojibake literals between the escapes (the sample was generated that way); only `\u233` -> `é` and the surrogate pair -> `😀` are clean. Assert on `startsWith("AéB")` and `includes("😀E")`. |
| `table.csv` | CSV (UTF-8) | Exact content `Name,City,Note\nAlice,Zürich,"has, comma"\nBob,Paris,"multi\nline"\n` (quoted comma and quoted newline). |
| `utf8.txt` | UTF-8, 67 bytes | `decodeText` (from `t/enc.ts`) -> encoding `utf-8`, text `Héllo wörld – café naïve “quotes” €5\nLine two: Zürich\n` |
| `utf8bom.txt` | UTF-8 + BOM, 70 bytes | encoding `utf-8-bom`, same text as utf8.txt (BOM stripped) |
| `utf16le.txt` | UTF-16LE + BOM, 110 bytes | encoding `utf-16le`, same text as utf8.txt |
| `utf16be.txt` | UTF-16BE + BOM, 110 bytes | encoding `utf-16be`, same text as utf8.txt |
| `utf16le-nobom.txt` | UTF-16LE no BOM, 108 bytes | encoding `utf-16le-nobom`, same text as utf8.txt |
| `latin1.txt` | ISO-8859-1, 32 bytes | encoding `windows-1252` (fallback), text `Héllo wörld - café naïve Zürich\n` |
| `cp1252.txt` | Windows-1252, 22 bytes | encoding `windows-1252`, text `Smart “quotes” € café\n` |
| `drive-doc.gdoc` | Google Drive for Desktop link file (JSON, 109 bytes) | Single line `{"url": "https://docs.google.com/document/d/EXAMPLE/edit", "doc_id": "EXAMPLE", "email": "user@example.com"}` plus trailing newline. Hand made. |
| `binary.bin` | 64 random-ish bytes | Hex starts `000102ff0041000...`; NULs at both even and odd offsets, so it is not UTF-16 and `decodeText` throws `Error("binary")`. Hand made. |

`decodeText` and `rtfToText` live in the research scratch scripts, not in the repo; the engineers must implement
their own versions (the heuristic is BOM, then NUL-pattern UTF-16 detection, then NUL => binary, then strict UTF-8,
then windows-1252).

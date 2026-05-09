import { Injectable } from "@nestjs/common";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export type DocumentIngestFailureKind = "unsupported" | "empty" | "parse_error";

export type DocumentIngestResult =
  | { ok: true; text: string }
  | { ok: false; kind: DocumentIngestFailureKind; detail?: string };

const MAX_EXTRACTED_CHARS = 5_000_000;

@Injectable()
export class DocumentIngestService {
  async extractText(buffer: Buffer, meta: { fileName?: string; mimeType?: string }): Promise<DocumentIngestResult> {
    const format = this.detectFormat(meta);
    if (format === "unsupported") {
      return { ok: false, kind: "unsupported" };
    }

    try {
      let text: string;
      if (format === "pdf") {
        text = await this.extractPdf(buffer);
      } else if (format === "docx") {
        const result = await mammoth.extractRawText({ buffer });
        text = result.value;
      } else {
        text = this.extractPlainText(buffer);
      }

      const normalized = text.replace(/\u0000/g, "").trim();
      if (!normalized) {
        return { ok: false, kind: "empty" };
      }
      const capped =
        normalized.length > MAX_EXTRACTED_CHARS
            //TODO ru hardcode
          ? `${normalized.slice(0, MAX_EXTRACTED_CHARS)}\n\n[… текст обрезан по лимиту]`
          : normalized;
      return { ok: true, text: capped };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return { ok: false, kind: "parse_error", detail };
    }
  }

    //TODO move types
  private detectFormat(meta: { fileName?: string; mimeType?: string }): "pdf" | "docx" | "txt" | "unsupported" {
    const name = meta.fileName?.toLowerCase() ?? "";
    const mime = meta.mimeType?.toLowerCase() ?? "";

    //TODO magics links
    if (name.endsWith(".pdf") || mime === "application/pdf") {
      return "pdf";
    }
    if (
      name.endsWith(".docx") ||
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      return "docx";
    }
    if (name.endsWith(".doc") && mime !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      return "unsupported";
    }
    if (
      name.endsWith(".txt") ||
      mime === "text/plain" ||
      mime === "text/x-plain" ||
      (mime === "application/octet-stream" && name.endsWith(".txt"))
    ) {
      return "txt";
    }

    return "unsupported";
  }

  private async extractPdf(buffer: Buffer): Promise<string> {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }

  private extractPlainText(buffer: Buffer): string {
    let s = buffer.toString("utf8");
    if (s.charCodeAt(0) === 0xfeff) {
      s = s.slice(1);
    }
    return s;
  }
}
